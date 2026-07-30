# Epic #470 — thin wrapper around the official docker:dind image, adding the
# deterministic egress-guard entrypoint (see entrypoint.sh). Everything else
# (dockerd itself, TLS cert generation, iptables) is the base image unchanged.
FROM docker:27-dind

COPY entrypoint.sh /usr/local/bin/omadia-dind-entrypoint.sh
RUN chmod +x /usr/local/bin/omadia-dind-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/omadia-dind-entrypoint.sh"]
