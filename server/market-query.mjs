import {CARDS,CARD_MAP} from '../src/data.ts';
import {getCombatStats} from '../src/battle.ts';

function invalid(message){const error=new Error(message);error.status=400;throw error;}
const median=(db,where,params)=>{
 const {n}=db.prepare('SELECT COUNT(*) n FROM listings l WHERE '+where).get(...params);
 if(!n)return null;
 return db.prepare('SELECT AVG(price) value FROM (SELECT price FROM listings l WHERE '+where+' ORDER BY price LIMIT ? OFFSET ?)').get(...params,n%2?1:2,Math.floor((n-1)/2)).value;
};
export function createMarketQuery(db){
 function listing(row){return {id:row.id,sellerId:row.seller_id,sellerName:row.seller_name,card:JSON.parse(row.card),price:row.price,createdAt:new Date(row.created_at).toISOString()};}
 return function marketSnapshot(user,query={}){
  const enumValue=(key,values,fallback='')=>{const value=query[key]??fallback;if(typeof value!=='string'||!values.includes(value))invalid('无效的市场筛选：'+key);return value;};
  const text=query.search??'';if(typeof text!=='string'||text.length>80)invalid('搜索内容过长');
  const rarity=enumValue('rarity',['','R','SR','SSR']);const affinity=enumValue('affinity',['','moon','sun','forest']);
  const role=enumValue('role',['','坦克','战士','射手','法师','刺客']);const rank=enumValue('rank',['','1','2','3']);
  const scope=enumValue('scope',['all','mine'],'all'),sort=enumValue('sort',['newest','oldest','low','high','level'],'newest');
  function amount(key){const raw=query[key];if(raw===undefined||raw==='')return null;if(typeof raw!=='string'||!/^\d{1,6}$/.test(raw))invalid('价格筛选必须是整数');const n=Number(raw);if(n<0||n>100000)invalid('价格筛选超出范围');return n;}
  const minPrice=amount('minPrice'),maxPrice=amount('maxPrice');if(minPrice!==null&&maxPrice!==null&&minPrice>maxPrice)invalid('最低价格不能高于最高价格');
  const rawPage=query.page??'1';if(typeof rawPage!=='string'||!/^\d{1,8}$/.test(rawPage)||Number(rawPage)<1)invalid('无效的市场页码');
  const search=text.trim().toLocaleLowerCase('zh-CN');
  const definitions=CARDS.filter(def=>(!search||def.name.toLocaleLowerCase('zh-CN').includes(search))&&(!rarity||def.rarity===rarity)&&(!affinity||def.affinity===affinity)&&(!role||getCombatStats({uid:'market-preview',defId:def.id,rank:1,best:0}).role===role));
  const clauses=[definitions.length?"json_extract(l.card,'$.defId') IN ("+definitions.map(()=>'?').join(',')+')':'0'];
  const cardParams=definitions.map(def=>def.id);if(rank){clauses.push("json_extract(l.card,'$.rank')=?");cardParams.push(Number(rank));}
  const cardWhere=clauses.join(' AND ');const activeClauses=["l.status='active'",cardWhere],activeParams=[...cardParams];
  if(scope==='mine'){activeClauses.push('l.seller_id=?');activeParams.push(user.id);}
  if(minPrice!==null){activeClauses.push('l.price>=?');activeParams.push(minPrice);}if(maxPrice!==null){activeClauses.push('l.price<=?');activeParams.push(maxPrice);}
  const activeWhere=activeClauses.join(' AND ');const total=db.prepare('SELECT COUNT(*) n FROM listings l WHERE '+activeWhere).get(...activeParams).n;
  const pageSize=20,page=Math.min(Number(rawPage),Math.max(1,Math.ceil(total/pageSize)));
  const order={newest:'l.created_at DESC,l.id DESC',oldest:'l.created_at ASC,l.id ASC',low:'l.price ASC,l.created_at DESC,l.id DESC',high:'l.price DESC,l.created_at DESC,l.id DESC',level:"json_extract(l.card,'$.rank') DESC,l.price ASC,l.id DESC"}[sort];
  const listings=db.prepare('SELECT l.*,u.name seller_name FROM listings l JOIN users u ON u.id=l.seller_id WHERE '+activeWhere+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...activeParams,pageSize,(page-1)*pageSize).map(listing);
  const mine=db.prepare("SELECT l.*,u.name seller_name FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.status='active' AND l.seller_id=? ORDER BY l.created_at DESC,l.id DESC").all(user.id).map(listing);
  const now=Date.now(),day=now-86400000,week=now-7*86400000;
  const globalActive=db.prepare("SELECT COUNT(*) activeListings,COUNT(DISTINCT seller_id) sellers FROM listings WHERE status='active'").get();
  const soldDay=db.prepare("SELECT COUNT(*) trades24h,COALESCE(SUM(price),0) volume24h FROM listings WHERE status='sold' AND closed_at>=?").get(day);
  const lowestPrice=db.prepare("SELECT MIN(price) value FROM listings l WHERE l.status='active' AND "+cardWhere).get(...cardParams).value;
  const soldWhere="l.status='sold' AND "+cardWhere;const recentWhere=soldWhere+' AND l.closed_at>=?';
  const sales24h=db.prepare('SELECT COUNT(*) n FROM listings l WHERE '+recentWhere).get(...cardParams,day).n;
  const lastPrice=db.prepare('SELECT price FROM listings l WHERE '+soldWhere+' ORDER BY l.closed_at DESC,l.id DESC LIMIT 1').get(...cardParams)?.price??null;
  const recentTrades=db.prepare('SELECT l.* FROM listings l WHERE '+soldWhere+' ORDER BY l.closed_at DESC,l.id DESC LIMIT 20').all(...cardParams).map(row=>({id:row.id,card:JSON.parse(row.card),price:row.price,closedAt:new Date(row.closed_at).toISOString()}));
  const history=db.prepare("SELECT * FROM listings WHERE (seller_id=? OR buyer_id=?) AND status IN ('sold','cancelled') ORDER BY closed_at DESC,id DESC LIMIT 30").all(user.id,user.id).map(row=>({id:row.id,type:row.status==='cancelled'?'cancel':row.seller_id===user.id?'sell':'buy',card:JSON.parse(row.card),price:row.price,fee:row.status==='sold'&&row.seller_id===user.id?Math.floor(row.price*.05):0,at:new Date(row.closed_at).toISOString()}));
  const quotes=new Map();
  const getQuote=(defId,rank)=>{const key=defId+':'+rank;if(!quotes.has(key))quotes.set(key,{defId,rank,activeCount:0,lowestPrice:null,lastPrice:null,medianPrice7d:null,sales7d:0});return quotes.get(key);};
  for(const row of db.prepare("SELECT json_extract(card,'$.defId') defId,json_extract(card,'$.rank') rank,COUNT(*) activeCount,MIN(price) lowestPrice FROM listings WHERE status='active' GROUP BY defId,rank").all())Object.assign(getQuote(row.defId,row.rank),row);
  for(const row of db.prepare(`WITH sold AS (SELECT json_extract(card,'$.defId') defId,json_extract(card,'$.rank') rank,price,closed_at,id FROM listings WHERE status='sold'), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY defId,rank ORDER BY closed_at DESC,id DESC) rn FROM sold) SELECT defId,rank,price lastPrice FROM ranked WHERE rn=1`).all())Object.assign(getQuote(row.defId,row.rank),row);
  for(const row of db.prepare(`WITH sold AS (SELECT json_extract(card,'$.defId') defId,json_extract(card,'$.rank') rank,price,id FROM listings WHERE status='sold' AND closed_at>=?), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY defId,rank ORDER BY price,id) rn,COUNT(*) OVER (PARTITION BY defId,rank) n FROM sold) SELECT defId,rank,MAX(n) sales7d,AVG(CASE WHEN rn IN ((n+1)/2,(n+2)/2) THEN price END) medianPrice7d FROM ranked GROUP BY defId,rank`).all(week))Object.assign(getQuote(row.defId,row.rank),row);
  return {listings,mine,page,pageSize,total,feePercent:5,stats:{...globalActive,...soldDay},quote:{lowestPrice,medianPrice24h:median(db,recentWhere,[...cardParams,day]),lastPrice,sales24h},recentTrades,history,quotes:[...quotes.values()].filter(q=>Object.hasOwn(CARD_MAP,q.defId))};
 };
}
