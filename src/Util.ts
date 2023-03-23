import { IChatJoinProperties } from "./bifrost/Events";
import { Intent, Logging, MatrixUser, WeakEvent } from "matrix-appservice-bridge";
import { JID } from "@xmpp/jid";
import * as crypto from "crypto";
import { stringprep } from "stringprep";

const log = Logging.get("Util.Lib");

export class Util {

    public static MINUTE_MS = 60000;

    public static createRemoteId(protocol: string, id: string): string {
        return `${protocol}://${id}`;
    }

    public static passwordGen(minLength: number = 32): string {
        let password = "";
        while (password.length < minLength) {
            // must be printable
            for (const char of crypto.randomBytes(32)) {
                if (char >= 32 && char <= 126) {
                    password += String.fromCharCode(char);
                }
            }
        }
        return password;
    }

    public static sanitizeProperties(props: IChatJoinProperties): IChatJoinProperties {
        for (const k of Object.keys(props)) {
            const value = props[k];
            const newkey = k.replace(/\./g, "·");
            delete props[k];
            props[newkey] = value;
        }
        return props;
    }

    public static desanitizeProperties(props: IChatJoinProperties): IChatJoinProperties {
        for (const k of Object.keys(props)) {
            const value = props[k];
            const newkey = k.replace(/·/g, ".");
            delete props[k];
            props[newkey] = value;
        }
        return props;
    }

    public static unescapeUserId(userId: string): string {
        userId = userId.replace(/(.+)=2f(.+)?=40([a-zA-Z0-9.-]+)$/g, "$1/$2@$3");
        userId = userId.replace(/(.+)?=40([a-zA-Z0-9.-]+)$/g, "$1@$2");
        // set hack to catch Phone Number jids (Cheogram, Quicksy)
        userId = userId.replace(/=2b([0-9]+)@([a-zA-Z0-9.-]+)$/g, "+$1@$2");
        return userId.replace(/(=[0-9a-f]{2,4})/g, (code) =>
            String.fromCharCode(parseInt(code.substr(1), 16)),
        );
    }

    public static getResourceFromMxid(mxid: string, prefix: string): string {
        const uName = this.unescapeUserId(new MatrixUser(mxid, {}, false).localpart);
        const rPrefix = prefix ? `(${prefix})` : "";
        let match = (new RegExp(`^${rPrefix}(.+\/)?(.+)?@(.+)$`)).exec(uName);
        if (!match) {
            match = (new RegExp(`^${rPrefix}(.+\/)?([^@]+)$`)).exec(uName);
            if (!match) {
                return null;
            }
        }
        const resource = match[2] ? match[2].substr(
            0, match[2].length - "/".length) : "";
        return resource === "" ? null : resource;
    }

    public static async getMessagesBeforeJoin(
        intent: Intent, roomId: string): Promise<WeakEvent[]> {
        const client = intent.getClient();
        // Because the JS SDK expects this to be set :/
        // eslint-disable-next-line no-underscore-dangle
        client._clientOpts = {
            lazyLoadMembers: false,
        };
        // eslint-disable-next-line no-underscore-dangle
        const res = await client._createMessagesRequest(roomId, undefined, undefined, "b");
        const msgs: WeakEvent[] = [];
        for (const msg of res.chunk.reverse()) {
            if (msg.type === "m.room.member" && msg.sender === client.getUserId()) {
                break;
            }
            if (msg.type === "m.room.message") {
                msgs.push(msg);
            }
        }
        return msgs;
    }

    public static sha1(data: string): string {
        return crypto.createHash("sha1").update(data, "ascii").digest("hex");
    }

    public static prepJID(j: JID): string {
        return (j.local !== "") ? `${j.local}@${j.domain}` : `${j.domain}`;
    }

    public static resourcePrep(resource: string|unknown): string|null {
        try {
            if (typeof (resource) === "string") {
                return stringprep.resourceprep(resource);
            }
        } catch (ex) {
            log.error(`Encountered error while resource prepping: ${ex}`);
        }
        return null;
    }
}