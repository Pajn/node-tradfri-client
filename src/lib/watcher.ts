import { EventEmitter } from "events";
import { TradfriClient } from "..";
import { ConnectionWatcherEventCallbacks, ConnectionWatcherEvents } from "./events";
import { log } from "./logger";

/** Configures options for connection watching and automatic reconnection */
export interface ConnectionWatcherOptions {
	/** The interval in ms between consecutive pings */
	pingInterval: number;
	/** How many pings have to consecutively fail until the gateway is assumed offline */
	failedPingCountUntilOffline: number;
	/**
	 * How much the interval between consecutive pings should be increased while the gateway is offline.
	 * The actual interval is calculated by <ping interval> * <backoff factor> ** <min(5, # offline pings)>
	 */
	failedPingBackoffFactor: number;

	/** Whether automatic reconnection is enabled */
	reconnectionEnabled: boolean;
	/** How many pings have to consecutively fail while the gateway is offline until a reconnection is triggered */
	offlinePingCountUntilReconnect: number;
	/** After how many failed reconnects we give up. Number.POSITIVE_INFINITY to never gonna give you up, never gonna let you down... */
	maximumReconnects: number;

	/** How many tries for the initial connection should be attempted */
	maximumConnectionAttempts: number;
	/** The interval in ms between consecutive connection attempts */
	connectionInterval: number;
	/**
	 * How much the interval between consecutive connection attempts should be increased.
	 * The actual interval is calculated by <connection interval> * <backoff factor> ** <min(5, # failed attempts)>
	 */
	failedConnectionBackoffFactor: number;
}

const defaultOptions: ConnectionWatcherOptions = Object.freeze({
	pingInterval: 10000, // 10s
	failedPingCountUntilOffline: 1,
	failedPingBackoffFactor: 1.5,

	reconnectionEnabled: true, // when the watch is enabled, also reconnect
	offlinePingCountUntilReconnect: 3,
	maximumReconnects: Number.POSITIVE_INFINITY, // don't stop believing

	connectionInterval: 10000, // 10s
	failedConnectionBackoffFactor: 1.5,
	maximumConnectionAttempts: Number.POSITIVE_INFINITY, // try to connect until the end of time
});

function checkOptions(opts: Partial<ConnectionWatcherOptions>) {
	if (opts.pingInterval != null && (opts.pingInterval < 1000 || opts.pingInterval > 5 * 60000)) {
		throw new Error("The ping interval must be between 1s and 5 minutes");
	}
	if (opts.failedPingCountUntilOffline != null && (opts.failedPingCountUntilOffline < 1 || opts.failedPingCountUntilOffline > 10)) {
		throw new Error("The failed ping count to assume the gateway as offline must be between 1 and 10");
	}
	if (opts.failedPingBackoffFactor != null && (opts.failedPingBackoffFactor < 1 || opts.failedPingBackoffFactor > 3)) {
		throw new Error("The interval back-off factor for failed pings must be between 1 and 3");
	}
	if (opts.offlinePingCountUntilReconnect != null && (opts.offlinePingCountUntilReconnect < 1 || opts.offlinePingCountUntilReconnect > 10)) {
		throw new Error("The failed ping count before a reconnect attempt must be between 1 and 10");
	}
	if (opts.maximumReconnects != null && opts.maximumReconnects < 1) {
		throw new Error("The maximum number of reconnect attempts must be at least 1");
	}
	if (opts.connectionInterval != null && (opts.connectionInterval < 1000 || opts.connectionInterval > 5 * 60000)) {
		throw new Error("The connection interval must be between 1s and 5 minutes");
	}
	if (opts.failedConnectionBackoffFactor != null && (opts.failedConnectionBackoffFactor < 1 || opts.failedConnectionBackoffFactor > 3)) {
		throw new Error("The interval back-off factor for failed connections must be between 1 and 3");
	}
	if (opts.maximumConnectionAttempts != null && opts.maximumConnectionAttempts < 1) {
		throw new Error("The maximum number of connection attempts must be at least 1");
	}
}

export interface ConnectionWatcher {
	on<TEvent extends ConnectionWatcherEvents>(event: TEvent, callback: ConnectionWatcherEventCallbacks[TEvent]): this;
	removeListener<TEvent extends ConnectionWatcherEvents>(event: TEvent, callback: ConnectionWatcherEventCallbacks[TEvent]): this;
	removeAllListeners(event?: ConnectionWatcherEvents): this;
}

/**
 * Watches the connection of a TradfriClient and notifies about changes in the connection state
 */
export class ConnectionWatcher extends EventEmitter {

	constructor(
		private client: TradfriClient,
		options?: Partial<ConnectionWatcherOptions>,
	) {
		super();
		if (options == null) options = {};
		checkOptions(options);
		this._options = {
			...defaultOptions,
			...options,
		};
	}

	private _options: ConnectionWatcherOptions;
	public get options() {
		return this._options;
	}
	private pingTimer: NodeJS.Timer | undefined;

	/** Starts watching the connection */
	public start() {
		if (this.pingTimer != null) throw new Error("The connection watcher is already running");
		this.isActive = true;
		this.pingTimer = setTimeout(() => void this.pingThread(), this._options.pingInterval);
	}

	private isActive: boolean | undefined;
	/** Stops watching the connection */
	public stop() {
		if (this.pingTimer != null) {
			clearTimeout(this.pingTimer);
			this.pingTimer = undefined;
		}
		this.isActive = false;
	}

	private connectionAlive: boolean | undefined;
	private failedPingCount: number = 0;
	private offlinePingCount: number = 0;
	private resetAttempts: number = 0;

	private async pingThread() {
		const oldValue = this.connectionAlive;
		this.connectionAlive = await this.client.ping();

		// see if the connection state has changed
		if (this.connectionAlive) {
			log("ping succeeded", "debug");
			this.emit("ping succeeded");
			// connection is now alive again
			if (oldValue === false) {
				log(`The connection is alive again after ${this.failedPingCount} failed pings`, "debug");
				this.emit("connection alive");
				// also restore the observers if necessary
				if (this.resetAttempts > 0) {
					// don't await or we might get stuck when the promise gets dropped
					void this.client.restoreObservers().catch(() => { /* doesn't matter, will be handled by the next ping */ });
				}
			}
			// reset all counters because the connection is good again
			this.failedPingCount = 0;
			this.offlinePingCount = 0;
			this.resetAttempts = 0;
		} else {
			this.failedPingCount++;
			log(`ping failed (#${this.failedPingCount})`, "debug");
			this.emit("ping failed", this.failedPingCount);
			if (oldValue === true) {
				log("The connection was lost", "debug");
				this.emit("connection lost");
			}

			// connection is dead
			if (this.failedPingCount >= this._options.failedPingCountUntilOffline) {
				if (this.failedPingCount === this._options.failedPingCountUntilOffline) {
					// we just reached the threshold, say the gateway is offline
					log(`${this.failedPingCount} consecutive pings failed. The gateway is offline.`, "debug");
					this.emit("gateway offline");
				}

				// if we should reconnect automatically, count the offline pings
				if (this._options.reconnectionEnabled) {
					this.offlinePingCount++;
					// as soon as we pass the threshold, reset the client
					if (this.offlinePingCount >= this._options.offlinePingCountUntilReconnect) {
						if (this.resetAttempts < this._options.maximumReconnects) {
							// trigger a reconnect
							this.offlinePingCount = 0;
							this.resetAttempts++;
							log(`Trying to reconnect... Attempt ${this.resetAttempts} of ${this._options.maximumReconnects === Number.POSITIVE_INFINITY ? "???" : this._options.maximumReconnects}`, "debug");
							this.emit("reconnecting", this.resetAttempts, this._options.maximumReconnects);
							const reconnectResult = await this.client.reconnectHandler();
							if (!reconnectResult) {
								// The connection cannot be re-established, give up
								log("Cannot reconnect... giving up.", "debug");
								this.emit("give up");
								// increase the counter once more so this branch doesn't get hit
								this.resetAttempts = this._options.maximumReconnects + 1;
								return;
							}
						} else if (this.resetAttempts === this._options.maximumReconnects) {
							// don't try anymore
							log("Maximum reconnect attempts reached... giving up.", "debug");
							this.emit("give up");
							// increase the counter once more so this branch doesn't get hit
							this.resetAttempts++;
							return;
						}
					}
				}
			}
		}

		// schedule the next ping
		if (this.isActive) {
			const nextTimeout = Math.round(this._options.pingInterval * this._options.failedPingBackoffFactor ** Math.min(5, this.failedPingCount));
			log("setting next timeout in " + nextTimeout, "debug");
			this.pingTimer = setTimeout(() => void this.pingThread(), nextTimeout);
		}
	}
}
