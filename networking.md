# OVH OpenStack + RKE2 + Tailscale Networking Issues

## 1. OVH IPv6 breaks RKE2 worker joins

**Problem:** OVH assigns both IPv4 and IPv6 to instances. Without `node-ip` set, RKE2
picks the IPv6 address as the supervisor endpoint and advertises it to workers. Workers
can't reach the control-plane via IPv6 on OVH's network.

**Symptom:** `rke2-agent` log shows:
```
Updated load balancer rke2-agent-load-balancer default server: [2607:5300:...]:9345
Failed to validate connection ... connection reset by peer
```

**Fix (cloud-init):** Before RKE2 starts, write a drop-in config:
```bash
PRIMARY_IP=$(ip route get 8.8.8.8 | grep -oP 'src \K[\d.]+' | head -1)
printf 'node-ip: "%s"\n' "$PRIMARY_IP" > /etc/rancher/rke2/config.yaml.d/05-node-ip.yaml
```

---

## 2. Pods can't resolve *.ts.net (Tailscale MagicDNS)

**Problem:** Ubuntu uses `127.0.0.53` (systemd-resolved stub) in `/etc/resolv.conf`.
That address is unreachable from inside pods. CoreDNS forwards to it and fails.
Tailscale's `100.100.100.100` MagicDNS is also unreachable from pods — it's only on
the host's Tailscale interface.

**Fix — two parts:**

**Part A:** Make systemd-resolved listen on the node's primary IP:
```bash
PRIMARY_IP=$(ip route get 8.8.8.8 | grep -oP 'src \K[\d.]+' | head -1)
mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNSStubListenerExtra=%s\n' "$PRIMARY_IP" > /etc/systemd/resolved.conf.d/pod-dns.conf
systemctl restart systemd-resolved
```

**Part B:** Configure CoreDNS to forward `ts.net` to that IP via a `HelmChartConfig`
placed in `/var/lib/rancher/rke2/server/manifests/` before RKE2 starts:
```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-coredns
  namespace: kube-system
spec:
  valuesContent: |-
    servers:
    - zones:
      - zone: ts.net.
      port: 53
      plugins:
      - name: errors
      - name: forward
        parameters: . <PRIMARY_IP>
      - name: cache
        parameters: "30"
```

**Note:** The Tailscale k8s-nameserver (via DNSConfig CRD) only resolves in-cluster
Tailscale proxy names — it does NOT resolve external MagicDNS like
`rancher-1.humpback-salary.ts.net`. You still need the systemd-resolved forwarding
approach for external Tailscale devices.

---

## 3. Pods can't connect to Tailscale IPs (100.x.x.x)

**Problem:** Tailscale adds routes only to routing table 52 (policy routing). Forwarded
pod traffic uses the main routing table. Pods can resolve `*.ts.net` to `100.x.x.x`
but then can't connect.

**Symptom:** `wget` or `curl` to a Tailscale IP from a pod times out (not even a TCP
connection). Running `ip route get 100.x.x.x from <pod-ip>` returns "unreachable".

**Fix (cloud-init, after `tailscale up`):**
```bash
# Add Tailscale CGNAT range to main table so pod forwarding works
ip route add 100.64.0.0/10 dev tailscale0 table main 2>/dev/null || true

# Masquerade pod/service traffic via tailscale0 so source IP is node's Tailscale IP
iptables -t nat -A POSTROUTING -s 10.42.0.0/16 -o tailscale0 -j MASQUERADE
iptables -t nat -A POSTROUTING -s 10.43.0.0/16 -o tailscale0 -j MASQUERADE
```

---

## 4. Tailscale DNSConfig nameserver pod tolerations

**Problem:** The Tailscale operator creates a `nameserver` deployment with no tolerations.
On a control-plane-only cluster (workers not yet ready), the pod stays Pending.

**Fix:** Use `spec.nameserver.pod.tolerations` in the DNSConfig CRD (supported since
recent operator versions). Set via cloud-init manifest:
```yaml
spec:
  nameserver:
    pod:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
          operator: Exists
        - key: node-role.kubernetes.io/etcd
          effect: NoExecute
          operator: Exists
```

**Note:** `nameserverConfig.tolerations` in the operator's Helm values does NOT work
as expected — it does not propagate to the nameserver deployment. Use the DNSConfig
CRD field instead.

---

## 5. CoreDNS patch ordering (chicken-and-egg)

**Problem:** `cattle-cluster-agent` needs DNS to connect to Rancher. Rancher marks the
cluster ready only after the agent connects. A post-provisioning CoreDNS patch is too
late — the agent is already in CrashLoopBackOff with exponential backoff.

**Fix:** Use a `HelmChartConfig` for `rke2-coredns` placed in the manifests dir via
cloud-init (see #2 above). This is applied during initial chart install, before the
agent ever starts.
