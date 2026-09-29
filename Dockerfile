FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies

WORKDIR /dependencies
COPY fixtures/base/package.json fixtures/base/package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
	if [ -f /run/secrets/build_ca ]; then \
		NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm ci --no-audit --no-fund; \
	else \
		npm ci --no-audit --no-fund; \
	fi

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS glibc

FROM docker.io/cloudflare/sandbox:next-musl@sha256:eb5b6a4bd61aa6791594d9b73049925b2011fff7fb08a0e9ab2bdb0d7ee94be6 AS sandbox-runtime

FROM docker:29-dind-rootless@sha256:8a213afdd096a44dff403aaf8eb58b7a96a63113f18a4b094b98b7d0ed7d948b

USER root

COPY --from=sandbox-runtime /container-server/sandbox /sandbox
COPY --from=sandbox-runtime /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=sandbox-runtime /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=sandbox-runtime /bin/bash /bin/bash
COPY --from=sandbox-runtime /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=sandbox-runtime /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2
COPY --from=glibc /lib/x86_64-linux-gnu /lib/x86_64-linux-gnu
COPY --from=glibc /lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/lib/node_modules /usr/local/lib/node_modules

ENV CI=1 \
	NEXT_TELEMETRY_DISABLED=1 \
	COMPATIBILITY_DOCKER_NETWORK=host

WORKDIR /opt/pipeline
COPY --chown=rootless:rootless --from=dependencies /dependencies/node_modules ./fixtures/base/node_modules
COPY --chown=rootless:rootless fixtures ./fixtures
COPY --chown=rootless:rootless runner ./runner

# apk reads the system trust bundle; mount an optional build-only CA there for inspected networks.
RUN --mount=type=secret,id=build_ca,target=/etc/ssl/cert.pem,required=false \
	apk add --no-cache python3 && \
	ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
	ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
	mkdir -p /workspace && \
	chown rootless:rootless /workspace && \
	printf '#!/bin/sh\nset -eu\ndockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false &\nuntil docker version >/dev/null 2>&1; do sleep 0.2; done\necho "Docker is ready"\nwait\n' > /home/rootless/boot-docker-for-dind.sh && \
	chown rootless:rootless /home/rootless/boot-docker-for-dind.sh && \
	chmod +x /home/rootless/boot-docker-for-dind.sh

EXPOSE 3000 8080
ENTRYPOINT ["/sandbox"]
CMD ["/home/rootless/boot-docker-for-dind.sh"]
