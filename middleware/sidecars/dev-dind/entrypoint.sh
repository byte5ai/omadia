#!/bin/sh
# Epic #470 — deterministic fail-fast for any nested (per-job) container that
# somehow attempts a direct connection instead of going through the egress
# proxy at 172.28.5.3 (dev-egress). Confirmed live (2026-07-29): dev-dind's
# own two networks (dev-engine, dev-egress) are BOTH `internal: true`, so a
# bypass attempt was already structurally incapable of reaching the real
# internet — but depending on kernel/network state, the failure mode varied
# between an instant ENETUNREACH and a silent multi-minute TCP blackhole
# (observed: ~240s). That variable stall, not the bypass itself, is what
# re-triggered npm's own confirmed ExitHandler re-entrancy race (npm/cli#9751
# — the same bug class behind the original EAI_AGAIN-driven crash this whole
# investigation started from).
#
# This adds a small, STATEFUL iptables ruleset in dev-dind's OWN network
# namespace (already `privileged: true` — no new capability granted
# anywhere): any FORWARDED packet — i.e. traffic dind is relaying from a
# nested per-job container, never dind's own process-level traffic, which
# uses OUTPUT, not FORWARD, and is untouched by this — gets REJECTed (not
# silently dropped) UNLESS it belongs to an already-established connection
# (conntrack ESTABLISHED,RELATED — required for the proxy's own RETURN
# traffic, whose destination is the job container's per-job IP, never the
# proxy's own subnet) or is headed to the proxy's own network (172.28.5.0/24,
# dev-egress, for the connection's initiating leg). Everything else fails in
# milliseconds instead of minutes. Zero change to the job container's own
# security clamp (CapDrop: ALL, no-new-privileges, single NetworkMode) —
# this lives entirely one layer down, in dind's netns.
set -eu

# Start dockerd via the base image's own entrypoint, in the background, so
# DOCKER-USER (created by dockerd itself on boot) exists before we touch it.
/usr/local/bin/dockerd-entrypoint.sh "$@" &
DOCKERD_PID=$!

# Poll for DOCKER-USER rather than a fixed sleep — dockerd's own boot time
# varies (image pulls, TLS cert generation).
until iptables -L DOCKER-USER >/dev/null 2>&1; do
  sleep 0.2
done

# Idempotent: a restart of this container must not stack duplicate rules.
iptables -N OMADIA-EGRESS-GUARD 2>/dev/null || true
iptables -F OMADIA-EGRESS-GUARD
# RETURN-leg traffic for an ALREADY-established connection (proxy -> job
# container: TCP ACKs, the CONNECT response, tunnel data) is forwarded with
# its destination being the JOB CONTAINER's own per-job-network IP, never
# 172.28.5.0/24 — a destination-only rule rejects that return traffic too,
# breaking every legitimate proxy-bound connection after its first packet.
# Confirmed live (2026-07-29): with only the destination rule, the shim's
# own phone-home fetch failed instantly on every attempt; flushing the chain
# entirely fixed it immediately. This conntrack rule must come first.
iptables -A OMADIA-EGRESS-GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A OMADIA-EGRESS-GUARD -d 172.28.5.0/24 -j RETURN
iptables -A OMADIA-EGRESS-GUARD -j REJECT --reject-with icmp-net-unreachable
iptables -C DOCKER-USER -j OMADIA-EGRESS-GUARD 2>/dev/null \
  || iptables -I DOCKER-USER 1 -j OMADIA-EGRESS-GUARD

wait "$DOCKERD_PID"
