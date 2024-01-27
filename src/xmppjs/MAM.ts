import { WeakEvent, Intent, Bridge, Logging } from "matrix-appservice-bridge";
import { IBasicProtocolMessage, MessageFormatter } from "../MessageFormatter";
import { XmppJsInstance } from "./XJSInstance";
import { IConfigBridge } from "../Config";
import { MatrixMessageEvent } from "../MatrixTypes";
import { IFetchReceivedGroupMsg } from "../bifrost/Events";
import { Util } from "../Util";

const log = Logging.get("MAMHandler");

// matrix-js-sdk lacks types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Filter } = require('matrix-js-sdk');

// This is the library containing MAM (XEP-0313) class and functions

const MAM_CACHE_MAX_LENGTH = 30000;
const MAM_REQUEST_DEFAULT_SIZE = 50;
const MAM_REQUEST_MAX_SIZE = 200;

const MESSAGE_FILTER = {
    room: {
        include_leave: false,
        state: {
            limit: 0,
        },
        timeline: {
            types: ["m.room.messages"],
        },
        account_data: {
            limit: 0,
        }
    },
};

export interface IBifrostMAMEntry {
    timestamp: number;
    from: string;
    to: string;
    payload: IBasicProtocolMessage;
    originId?: string;
    remoteId?: string;
    stanzaId?: string;
}

export interface IBifrostMAMResultSet {
    results: IBifrostMAMEntry[];
    count: number;
    index: number;
    first_id?: string|undefined;
    last_id?: string|undefined;
    complete?: boolean;
    not_found?: boolean;
}

export interface IBifrostMAMRequest {
    gatewayAlias: string;
    gatewayJID: string;
    roomId: string;
    start?: Date;
    end?: Date;
    with?: string;
    rsm?: { before: true|string|undefined, after: true|string|undefined, max: number|undefined };
}

export class MAMHandler {
    private mamCache: Map<string, Array<WeakEvent>>;
    private archiveFE: Map<string, number>;
    private archiveLE: Map<string, number>;
    private archivePaginationTokens: Map<string, string>;
    private botIntent: Intent;
    private readonly fields: Map<string, string>;

    constructor(private xmpp: XmppJsInstance, private bridge: Bridge, private config: IConfigBridge) {
        this.mamCache = new Map();
        this.archiveFE = new Map();
        this.archiveLE = new Map();
        this.archivePaginationTokens = new Map();
        this.botIntent = this.bridge.getIntent();
        this.fields = new Map([
            [ "start", "text-single" ],
            [ "end", "text-single" ],
            [ "with", "jid-single" ],
        ]);
        this.xmpp.on("mam-add-entry", this.addEntry.bind(this));
    }

    public supportedFields(): Map<string, string> {
        return this.fields;
    }

    public async getEntries(request: IBifrostMAMRequest, intent?: Intent): Promise<IBifrostMAMResultSet> {
        try {
            let results: IBifrostMAMEntry[] = [];
            let index: number;
            let start_idx: number;
            let end_idx: number;
            let fst_lst: { fst: string, lst: string };
            let complete: boolean = false;
            let not_found: boolean = false;

            if (!intent) {
                intent = this.botIntent;
            }

            // check if we have an archive already to try fetching from and appending to
            let archiveCache = this.mamCache.get(request.roomId);
            let previous: any;
            if (!archiveCache) {
                try {
                    // bootstrap archive
                    log.info(`Bootstrapping archive for ${request.roomId}, attempting to fetch the last 5000 entries`);
                    await this.convergeEvRoomCache(request.roomId, intent);
                    archiveCache = this.mamCache.get(request.roomId);
                    while (previous !== archiveCache.length && archiveCache.length <= 5000) {
                        await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                        previous = archiveCache.length;
                    }
                } catch (ex) {
                    log.error(`Error converging cache: ${ex}`);
                }
                archiveCache = this.mamCache.get(request.roomId);
            }

            let archiveStart: number;
            let archiveEnd: number;
            if (request.start && (!request.end || request.start < request.end)) {
                archiveStart = archiveCache.findIndex((ev) => ev.origin_server_ts < request.start.valueOf());
                while (archiveStart === -1 && previous !== archiveCache.length && archiveCache.length <= MAM_CACHE_MAX_LENGTH) {
                    await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                    archiveStart = archiveCache.findIndex((ev) => ev.origin_server_ts < request.start.valueOf());
                    previous = archiveCache.length;
                }
            } else if (request.with) {
                while (previous !== archiveCache.length && archiveCache.length <= MAM_CACHE_MAX_LENGTH) {
                    await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                    previous = archiveCache.length;
                }
            } else if (request.end) {
                archiveEnd = archiveCache.findIndex((ev) => ev.origin_server_ts <= request.end.valueOf());
                while (archiveEnd === -1 && previous !== archiveCache.length && archiveCache.length <= MAM_CACHE_MAX_LENGTH) {
                    await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                    archiveEnd = archiveCache.findIndex((ev) => ev.origin_server_ts <= request.end.valueOf());
                    previous = archiveCache.length;
                }
            }
            log.info(`Got MAM parameters -> start:${request.start?.valueOf()} end:${request.end?.valueOf()} with:${request.with}`);

            if (!request.rsm) {
                // assume last page
                if (archiveCache.length > 0) {
                    start_idx = archiveCache.length - MAM_REQUEST_DEFAULT_SIZE > 0 ? archiveCache.length - MAM_REQUEST_DEFAULT_SIZE : 0;
                    end_idx = archiveCache.length - 1;
                    log.info(`No RSM parameters, getting last page of -> ${request.roomId} s:${start_idx} e:${end_idx}`);
                    fst_lst = await this.sliceAndRenderArchiveCache(
                        request, results, archiveCache, start_idx, end_idx, MAM_REQUEST_DEFAULT_SIZE
                    );
                }
            } else {
                let max: number = request.rsm.max;
                if (!max) {
                    max = MAM_REQUEST_DEFAULT_SIZE;
                } else if (max > MAM_REQUEST_MAX_SIZE) {
                    max = MAM_REQUEST_MAX_SIZE;
                }

                if (request.rsm.before === true) {
                    archiveEnd = archiveCache.length - 1;
                    while (archiveEnd < max && previous !== archiveEnd && archiveCache.length <= MAM_CACHE_MAX_LENGTH) {
                        previous = archiveEnd;
                        await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                        archiveEnd = archiveCache.length - 1;
                    }
                    end_idx = archiveCache.length - 1;
                } else if (request.rsm.after === true) {
                    if (!request.start && !request.end) {
                        throw Error("Need to specify either a start or end offset to request the page after it");
                    }
                    start_idx = archiveCache.findIndex((ev) => ev.origin_server_ts > (request.start?.valueOf() || request.end?.valueOf()));
                    end_idx = start_idx !== -1 ? start_idx + max : undefined;
                } else if (typeof request.rsm.before === "string" && typeof request.rsm.after === "string") {
                    start_idx = archiveCache.findIndex((ev) => ev.event_id === request.rsm.after) + 1;
                    end_idx = archiveCache.findIndex((ev) => ev.event_id === request.rsm.before) - 1;
                    if (start_idx === -1 || end_idx === -1) {
                        not_found = true;
                    }
                } else if (typeof request.rsm.before === "string") {
                    // get index ofset
                    end_idx = archiveCache.findIndex((ev) => ev.event_id === request.rsm.before) - 1;
                    while (end_idx === -1 && previous !== end_idx && archiveCache.length - 1 <= MAM_CACHE_MAX_LENGTH) {
                        previous = end_idx;
                        await this.convergeEvRoomCache(request.roomId, intent, this.archivePaginationTokens.get(request.roomId));
                        end_idx = archiveCache.findIndex((ev) => ev.event_id === request.rsm.before);
                    }
                    if (end_idx === -1) {
                        not_found = true;
                    }
                } else if (typeof request.rsm.after === "string") {
                    start_idx = archiveCache.findIndex((ev) => ev.event_id === request.rsm.after) + 1;
                    if (start_idx !== -1) {
                        end_idx = start_idx + max;
                    } else if (start_idx === -1) {
                        not_found = true;
                    }
                }
                if (!not_found && request.rsm.before && !request.rsm.after) {
                    start_idx = end_idx - max >= 0 ? end_idx - max : 0;
                }
                if (start_idx !== -1) {
                    log.info(`RSM Params: max ${request.rsm.max}, before ${request.rsm.before}, after ${request.rsm.after} -> ${request.roomId} s:${start_idx} e:${end_idx}`);
                    fst_lst = await this.sliceAndRenderArchiveCache(request, results, archiveCache, start_idx, end_idx, max);
                }
                index = archiveCache.findIndex((ev) => ev.event_id === fst_lst.fst);
                if (request.rsm.after && !fst_lst.fst && !fst_lst.lst && results.length === 0) {
                    // assume end of archive
                    complete = true;
                } else {
                    complete = archiveCache[archiveCache.length - 1]?.event_id === fst_lst.lst ? true : false;
                }
                log.info(`Returning ${results.length} messages`);
            }

            return {
                results: results,
                count: archiveCache.length - 1 > 0 ? archiveCache.length - 1 : 0,
                index: index,
                first_id: fst_lst.fst,
                last_id: fst_lst.lst,
                complete: complete,
                not_found: not_found,
            };
        } catch (ex) {
            log.error("MAM getEntries() Exception:", ex);
        }
    }

    public async addEntry(data: IFetchReceivedGroupMsg) {
        try {
            const roomCache = this.mamCache.get(data.room_id);
            if (roomCache) {
                log.info(`Add message ${data.event.event_id} for ${data.room_id} cache`);
                roomCache.push(data.event);
            }
        } catch (ex) {
            log.error("MAM addEntry() Exception:", ex);
        }
    }

    private async sliceAndRenderArchiveCache(
        request: IBifrostMAMRequest, results: IBifrostMAMEntry[], cache: WeakEvent[], f: number, l: number, m: number
    ): Promise<{ fst: string; lst: string; }>  {
        try {
            let count = 0;
            let fst: string;
            let lst: string;
            const state = await this.botIntent.roomState(request.roomId).catch((ex) => {
                log.warn(`Failed to fetch ${request.roomId} state for MUC Nicks -> ${ex}`);
            });
            const membership: { displayname?: string, sender: string }[] =
                (state as unknown as WeakEvent[]).filter((e) => e.type === "m.room.member").map((e: WeakEvent) => (
                    {
                        displayname: Util.resourcePrep(e.content.displayname),
                        sender: e.sender,
                    }
                ));
            for (const ev of cache.slice(f, l)) {
                if (request.start && ev.origin_server_ts < request.start.valueOf()) {
                    continue;
                } else if (request.end && ev.origin_server_ts > request.end.valueOf()) {
                    continue;
                }
                let mucNick: string =
                    request.gatewayJID + "/" + (membership?.find((member) => ev.sender === member.sender)?.displayname || ev.sender);
                if (request.with && request.with !== mucNick) {
                    continue;
                }
                if (count >= m) {
                    break;
                }
                if (!fst) {
                    fst = ev.event_id;
                }
                results.push({
                    timestamp: ev.origin_server_ts,
                    from: mucNick,
                    to: request.gatewayJID,
                    payload: MessageFormatter.matrixEventToBody(ev as MatrixMessageEvent, this.config),
                    originId: ev.content?.origin_id as string,
                    remoteId: ev.content?.remote_id as string,
                    stanzaId: ev.content?.stanza_id as string,
                });
                lst = ev.event_id;
                count++;
            }
            return { fst, lst }
        } catch (ex) {
            log.error("MAM sliceAndRenderArchiveCache() Exception:", ex);
        }
    }

    private async fetchMessagesFromMatrix(
        intent: Intent, roomId: string, token?: string, max?: number): Promise<{ end: string, events: WeakEvent[] }> {
        try {
            const client = intent.getClient();
            const filter = new Filter(MESSAGE_FILTER);
            client._clientOpts = {
                lazyLoadMembers: false,
            };
            const res = await client._createMessagesRequest(roomId, token, max, "b", filter);
            const events: WeakEvent[] = [];
            for (const msg of res.chunk.reverse()) {
                if (msg.type === "m.room.message") {
                    events.push(msg);
                }
            }
            return { end: res.end, events: events };
        } catch (ex) {
            log.error("MAM fetchMessageFromMatrix() Exception:", ex);
        }
    }

    private async convergeEvRoomCache(roomId: string, intent: Intent, token?: string) {
        try {
            let mamCache: Array<WeakEvent>;
            if (!this.mamCache.has(roomId)) {
                log.info(`Creating new cache for -> ${roomId}`);
                this.mamCache.set(roomId, new Array());
            }
            mamCache = this.mamCache.get(roomId);
            let messageBatch: { end: string, events: WeakEvent[] };
            try {
                log.info(`Fetching messages from Matrix... -> ${roomId}`);
                messageBatch = await this.fetchMessagesFromMatrix(intent, roomId, token, 300);
            } catch (ex) {
                log.error(`Failed to fetch messages: ${ex}`);
            }
            this.archivePaginationTokens.set(roomId, messageBatch.end);
            for (const event of messageBatch.events) {
                if (mamCache.find((ev) => ev.event_id === event.event_id)) {
                    continue; // perform deduplication
                }
                mamCache.push(event);
            }
            if (token) { // sort out the array based on event age
                mamCache.sort((a, b) => a.origin_server_ts - b.origin_server_ts);
            }
            log.info(`Setting FE and LE for -> ${roomId}`);
            this.archiveFE.set(roomId, mamCache[0]?.origin_server_ts);
            this.archiveLE.set(roomId, mamCache[mamCache.length - 1]?.origin_server_ts);
        } catch (ex) {
            log.error("MAM convergeEvRoomCache() Exception:", ex);
        }
    }
}