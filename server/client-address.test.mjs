import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAddress,trustedProxiesFromEnv,clientAddress} from './client-address.mjs';
const request=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':forwarded}});
test('限流地址规范化 IPv6 与 IPv4-mapped，不接受端口、scope 或无效 IP',()=>{
 assert.equal(normalizeAddress('::ffff:192.0.2.7'),'192.0.2.7');
 assert.equal(normalizeAddress('::FFFF:c000:207'),'192.0.2.7');
 assert.equal(normalizeAddress('2001:0DB8:0:0::1'),'2001:db8::1');
 for(const ip of ['unknown','127.0.0.1:80','fe80::1%eth0','192.168.001.1',''])assert.equal(normalizeAddress(ip),null);
});
test('可信代理配置仅接受有效 IP/CIDR；默认不信任任何代理',()=>{
 for(const value of ['proxy.local','127.0.0.1/33','::1/129','127.0.0.1/-1','127.0.0.1/','127.0.0.1/24/1'])assert.throws(()=>trustedProxiesFromEnv(value),/TRUSTED_PROXIES/);
 assert.equal(clientAddress(request('192.0.2.1','198.51.100.1'),trustedProxiesFromEnv()),'192.0.2.1');
});
test('只有可信 socket 可使用转发链，从右向左取第一个不可信地址',()=>{
 const proxies=trustedProxiesFromEnv('172.30.0.2,192.0.2.0/24,2001:db8::/64');
 assert.equal(clientAddress(request('172.30.0.2','198.51.100.1'),proxies),'198.51.100.1');
 assert.equal(clientAddress(request('::ffff:172.30.0.2','198.51.100.66,203.0.113.7,192.0.2.8'),proxies),'203.0.113.7');
 assert.equal(clientAddress(request('203.0.113.7','198.51.100.1'),proxies),'203.0.113.7');
 assert.equal(clientAddress(request('2001:db8::2','198.51.100.7'),proxies),'198.51.100.7');
});
test('缺失、畸形或过长转发链回退 socket，不能从坏链挑选攻击者地址',()=>{
 const proxies=trustedProxiesFromEnv('172.30.0.2');
 for(const header of [undefined,'','bad,198.51.100.1','198.51.100.1:80',Array(33).fill('198.51.100.1').join(','),'x'.repeat(2049),['198.51.100.1']])assert.equal(clientAddress(request('172.30.0.2',header),proxies),'172.30.0.2');
});
