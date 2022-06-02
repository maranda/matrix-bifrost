# matrix-bifröst

General purpose puppeting bridges using XMPP-JS and possibly other backends.

This is a fork of the [Matrix Bifröst](https://github.com/matrix-org/matrix-bifrost) bridge used on [Aria Network](https://aria-net.org), it's currently in very active development as opposed to the upstream version.

## Service support

You can get support for the Aria Network bridge instance in [#bifrost:aria-net.org](https://matrix.to/#/#bifrost:aria-net.org)

## Backends

This bridge features multiple backends for spinning up bridges on different types of network.
The following are supported:
* `xmpp.js`
    Designed to bridge to XMPP networks directly, without purple. Good for setups requiring an extremely scalable XMPP bridge. Uses XMPP components.

## Docker

Both backends are supported in Docker. You can go straight ahead and use the provided Dockerfile
to build the bridge. You can build the docker image with `docker build -t bifrost:latest` and then
run the image with: `docker run -v /your/path/to/data:/data bifrost:latest -p 5000:9555`.

An image is available on [Dockerhub](https://hub.docker.com/r/matrixdotorg/matrix-bifrost).

### Things to note

- Make sure you store your `config.yaml`, `registration.yaml` inside /data.
- You should configure your `config.yaml`'s `userStoreFile` and `roomStoreFile` to point to files inside `/data`
- The intenal port for the bridge is `5000`, you should map this to an external port in docker.
- Be careful not to leave any config options pointing to `127.0.0.1` / `localhost` as they will not resolve inside docker.
 - The exception to this rule is `bridge.domain`, which MUST be your homeserver's URL.

## Installing (non-docker)

### Dependencies

Simply run `yarn install` as normal.

### Installing & Configuring

**NOTE: You must carefully read the config.sample.yaml and use the bits appropriate for you. Do NOT copy and paste it verbatim as it won't work.**

```shell
yarn install # Install dependencies
yarn build # Build files
cp config.sample.yaml config.yaml
# ... Set the domain name, homeserver url, and then review the rest of the config
sed -i  "s/domain: \"localhost\"/domain: \"$YOUR_MATRIX_DOMAIN\"/g" config.yaml
```

You must also generate a registration file:

```shell
yarn genreg -- -u http://localhost:9555 # Set listener url here.
```

This file should be accessible by your **homeserver**, which will use this file to get the correct url and tokens to push events to.

For Synapse, this can be done by:

* Editing `app_service_config_files` in `homeserver.yaml` to include the full path of your registration file generated above.

```yaml
app_service_config_files: 
    - ".../bifrost-registration.yaml"
```

* Restart synapse, if it is running (`synctl restart`)


### XMPP bridge using the xmpp.js backend

After completing all the above, you should do the following:
* Set the `purple.backend` in `config.yaml` to `xmpp.js`
* Possibly change the registration file alias and user regexes
  to be `_xmpp_` instead of `_purple_`. Make sure to replicate those
  changes in `config.yaml`
* Setup your XMPP server to support a new component.
* Setup the `purple.backendOpts` options for the new component.
* Setup autoregistration and portals in `config.yaml`.

### Starting

The `start.sh` script will auto preload the build libpurple library and offers a better experience than the system libraries in most cases. Pleas remember to modify the port in the script if you are using a different port.

If you are not using the `node-purple` backend, you can just start the service with:

```shell
yarn start -- -p 9555
```
