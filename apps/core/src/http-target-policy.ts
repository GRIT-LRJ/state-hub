import { BlockList, isIP } from "node:net";

export interface ResolvedTargetAddress {
  address: string;
  family: number;
}

const grantable = new BlockList();
for (const [address, prefix, family] of [
  ["10.0.0.0", 8, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
] as const) grantable.addSubnet(address, prefix, family);

const special = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"],
] as const) special.addSubnet(address, prefix, family);

const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
const mappedIpv4 = new BlockList();
mappedIpv4.addSubnet("::ffff:0:0", 96, "ipv6");

function addressClass(address: string, family: number): "public" | "grantable" | "forbidden" {
  if (isIP(address) !== family) return "forbidden";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (grantable.check(address, type)) return "grantable";
  if (special.check(address, type)) return "forbidden";
  if (family === 4 || mappedIpv4.check(address, "ipv6")) return "public";
  return publicIpv6.check(address, "ipv6") ? "public" : "forbidden";
}

export function authorizeHttpTarget(
  target: URL,
  privateTargetOrigin: string | undefined,
  resolved: readonly ResolvedTargetAddress[],
): ResolvedTargetAddress {
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Only HTTP(S) targets are allowed");
  if (target.username || target.password) throw new Error("Credentials in target URLs are forbidden");
  let privateGrant = false;
  if (privateTargetOrigin !== undefined) {
    let grant: URL;
    try {
      grant = new URL(privateTargetOrigin);
    } catch {
      throw new Error("Private target grant must be a concrete HTTP(S) origin");
    }
    if (
      (grant.protocol !== "https:" && grant.protocol !== "http:") ||
      grant.username || grant.password || grant.pathname !== "/" || grant.search || grant.hash ||
      grant.origin !== target.origin
    ) throw new Error("Private target grant does not match the configured HTTP origin");
    privateGrant = true;
  }
  if (resolved.length === 0) throw new Error("Target hostname did not resolve");
  let sawPublic = false;
  let sawPrivate = false;
  for (const entry of resolved) {
    const kind = addressClass(entry.address, entry.family);
    if (kind === "forbidden" || (kind === "grantable" && !privateGrant)) {
      throw new Error("Target resolves to a blocked private, local, or special-use address");
    }
    sawPublic ||= kind === "public";
    sawPrivate ||= kind === "grantable";
  }
  if (sawPublic && sawPrivate) throw new Error("Mixed public and private DNS answers are forbidden");
  const selected = resolved[0];
  if (!selected) throw new Error("Target hostname did not resolve");
  return selected;
}
