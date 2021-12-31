import { Component, ComponentTLS } from "@xmpp/component-core";
import Reconnect from "@xmpp/reconnect";

export interface IXJSConnectionOptions {
    password: string;
    service: string;
    domain: string;
}

export class XJSConnection {
    public static connect(options: IXJSConnectionOptions) {
        const { password, service, domain } = options;

        const entity = service.startsWith("xmpps") ?
            new ComponentTLS({ service, domain }) : new Component({ service, domain });

        const reconnect = Reconnect({entity});

        entity.on("open", async (el) => {
            try {
                const {id} = el.attrs;
                await entity.authenticate(id, password);
            } catch (err) {
                entity.emit("error", err);
            }
        });

        return Object.assign(entity, {
            entity,
            reconnect,
        });
    }
}
