import {BlockList,isIP} from 'node:net';

// 统一 IPv6 文本与 IPv4-mapped 地址，避免同一个地址通过不同写法取得多个限流桶。
export function normalizeAddress(value) {
  if(typeof value!=='string'||value.includes('%')||!isIP(value))return null;
  if(isIP(value)===4)return value;
  const canonical=new URL('http://['+value+']/').hostname.slice(1,-1);
  const mapped=/^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if(!mapped)return canonical;
  const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);
  return [high>>>8,high&255,low>>>8,low&255].join('.');
}
export function trustedProxiesFromEnv(value='') {
  const proxies=new BlockList();
  for(const entry of value.split(',').map(s=>s.trim()).filter(Boolean)) {
    const [address,prefix,...extra]=entry.split('/');
    const ip=normalizeAddress(address),family=ip&&isIP(ip);
    if(!ip||extra.length||prefix!==undefined&&(!/^\d{1,3}$/.test(prefix)||Number(prefix)>(family===4?32:128)))
      throw new Error('TRUSTED_PROXIES 必须是逗号分隔的 IP 或 CIDR');
    const type=family===4?'ipv4':'ipv6';
    if(prefix===undefined)proxies.addAddress(ip,type);else proxies.addSubnet(ip,Number(prefix),type);
  }
  return proxies;
}
export function clientAddress(req,proxies) {
  const peer=normalizeAddress(req.socket.remoteAddress);
  if(!peer)return 'unknown';
  const trusted=ip=>!!proxies?.check(ip,isIP(ip)===4?'ipv4':'ipv6');
  if(!trusted(peer))return peer;
  const header=req.headers['x-forwarded-for'];
  if(typeof header!=='string'||header.length>2048)return peer;
  const entries=header.split(',');
  if(entries.length>32)return peer;
  const chain=entries.map(value=>normalizeAddress(value.trim()));
  // 非法链整体回退到 socket，不从攻击者控制的畸形头中挑出一个可用地址。
  if(chain.some(ip=>!ip))return peer;
  let current=peer;
  for(let i=chain.length-1;i>=0&&trusted(current);i--)current=chain[i];
  return current;
}
