import {CARDS,CARD_MAP} from '../src/data.ts';
import {getCombatStats} from '../src/battle.ts';

function invalid(message){const error=new Error(message);error.status=400;throw error;}
const median=(db,where,params)=>{
 const {n}=db.prepare('SELECT COUNT(*) n FROM listings l WHERE '+where).get(...params);
 if(!n)return null;
 return db.prepare('SELECT AVG(price) value FROM (SELECT price FROM listings l WHERE '+where+' ORDER BY price LIMIT ? OFFSET ?)').get(...params,n%2?1:2,Math.floor((n-1)/2)).value;
};
export function createMarketQuery(db,{now=Date.now,cacheTtlMs=5000}={}){
 // 只缓存公开行情；本人挂单、成交历史与当前商品列表始终逐请求读取。
 // 专用 revision 由触发器维护，其他表的心跳/聊天写入不会击穿缓存；回滚也回滚 revision。
 db.exec(`CREATE TABLE IF NOT EXISTS market_query_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
   INSERT OR IGNORE INTO market_query_revision(id,revision) VALUES(1,0);
   CREATE INDEX IF NOT EXISTS listings_quote_sales ON listings(json_extract(card,'$.defId'),json_extract(card,'$.rank'),closed_at DESC,id DESC) WHERE status='sold';
   CREATE INDEX IF NOT EXISTS listings_sold_time ON listings(closed_at DESC,id DESC) WHERE status='sold';
   CREATE INDEX IF NOT EXISTS listings_seller_history ON listings(seller_id,closed_at DESC,id DESC);
   CREATE INDEX IF NOT EXISTS listings_buyer_history ON listings(buyer_id,closed_at DESC,id DESC);`);
 for(const action of ['INSERT','UPDATE','DELETE'])db.exec('CREATE TRIGGER IF NOT EXISTS market_query_'+action.toLowerCase()+' AFTER '+action+' ON listings BEGIN UPDATE market_query_revision SET revision=revision+1 WHERE id=1; END;');
 if(!db.prepare("SELECT name FROM pragma_table_info('market_query_revision')").all().some(row=>row.name==='sales_revision'))db.exec('ALTER TABLE market_query_revision ADD COLUMN sales_revision INTEGER NOT NULL DEFAULT 0');
 // 免费上架/撤单只使在售统计失效，不能反复击穿历史成交的重聚合。
 for(const [action,condition] of [['INSERT',"NEW.status='sold'"],['DELETE',"OLD.status='sold'"],['UPDATE',"OLD.status='sold' OR NEW.status='sold'"]])db.exec('CREATE TRIGGER IF NOT EXISTS market_query_sales_'+action.toLowerCase()+' AFTER '+action+' ON listings WHEN '+condition+' BEGIN UPDATE market_query_revision SET sales_revision=sales_revision+1 WHERE id=1; END;');
 const revisionQuery=db.prepare('SELECT revision,sales_revision FROM market_query_revision WHERE id=1');
 const freshCache=()=>({revision:null,expiresAt:0,global:null,filters:new Map()});
 const marketCache=freshCache(),salesCache=freshCache();
 function cached(key,at,load,sales=false){
   // 事务内的未提交视图不得进入共享缓存（回滚后同 revision 可能被另一笔交易复用）。
   if(db.isTransaction)return load();
   const cache=sales?salesCache:marketCache,current=revisionQuery.get()[sales?'sales_revision':'revision'];
   if(current!==cache.revision||at>=cache.expiresAt){cache.revision=current;cache.expiresAt=at+cacheTtlMs;cache.global=null;cache.filters.clear();}
   if(key==='global')return cache.global??(cache.global=load());
   const filters=cache.filters;
   if(filters.has(key)){const value=filters.get(key);filters.delete(key);filters.set(key,value);return value;}
   const value=load();if(filters.size>=128)filters.delete(filters.keys().next().value);filters.set(key,value);return value;
 }
 function globalSales(at){return cached('global',at,()=>{
   const day=at-86400000,week=at-7*86400000;
   const stats=db.prepare("SELECT COUNT(*) trades24h,COALESCE(SUM(price),0) volume24h FROM listings WHERE status='sold' AND closed_at>=?").get(day);
   const quotes=new Map();
   const getQuote=(defId,rank)=>{const key=defId+':'+rank;if(!quotes.has(key))quotes.set(key,{defId,rank,lastPrice:null,medianPrice7d:null,sales7d:0});return quotes.get(key);};
   // 每个卡种/品质只做一次有索引的 LIMIT 1 查找，不再对全部历史成交做窗口排序。
   const latest=db.prepare("SELECT price FROM listings WHERE status='sold' AND json_extract(card,'$.defId')=? AND json_extract(card,'$.rank')=? ORDER BY closed_at DESC,id DESC LIMIT 1");
   for(const def of CARDS)for(let rank=1;rank<=5;rank++){const row=latest.get(def.id,rank);if(row)getQuote(def.id,rank).lastPrice=row.price;}
   for(const row of db.prepare(`WITH sold AS (SELECT json_extract(card,'$.defId') defId,json_extract(card,'$.rank') rank,price,id FROM listings WHERE status='sold' AND closed_at>=?), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY defId,rank ORDER BY price,id) rn,COUNT(*) OVER (PARTITION BY defId,rank) n FROM sold) SELECT defId,rank,MAX(n) sales7d,AVG(CASE WHEN rn IN ((n+1)/2,(n+2)/2) THEN price END) medianPrice7d FROM ranked GROUP BY defId,rank`).all(week))Object.assign(getQuote(row.defId,row.rank),row);
   return {stats,quotes:[...quotes.values()]};
 },true);}
 function globalMarket(at){return cached('global',at,()=>{
   const active=db.prepare("SELECT COUNT(*) activeListings,COUNT(DISTINCT seller_id) sellers FROM listings WHERE status='active'").get();
   const sales=globalSales(at),quotes=new Map();
   if(!db.isTransaction)marketCache.expiresAt=Math.min(marketCache.expiresAt,salesCache.expiresAt);
   const getQuote=(defId,rank)=>{const key=defId+':'+rank;if(!quotes.has(key))quotes.set(key,{defId,rank,activeCount:0,lowestPrice:null,lastPrice:null,medianPrice7d:null,sales7d:0});return quotes.get(key);};
   for(const row of db.prepare("SELECT json_extract(card,'$.defId') defId,json_extract(card,'$.rank') rank,COUNT(*) activeCount,MIN(price) lowestPrice FROM listings WHERE status='active' GROUP BY defId,rank").all())Object.assign(getQuote(row.defId,row.rank),row);
   for(const quote of sales.quotes)Object.assign(getQuote(quote.defId,quote.rank),quote);
   return {stats:{...active,...sales.stats},quotes:[...quotes.values()].filter(q=>Object.hasOwn(CARD_MAP,q.defId))};
 });}

 function listing(row){return {id:row.id,sellerId:row.seller_id,sellerName:row.seller_name,card:JSON.parse(row.card),price:row.price,createdAt:new Date(row.created_at).toISOString()};}
 return function marketSnapshot(user,query={}){
  const enumValue=(key,values,fallback='')=>{const value=query[key]??fallback;if(typeof value!=='string'||!values.includes(value))invalid('无效的市场筛选：'+key);return value;};
  const text=query.search??'';if(typeof text!=='string'||text.length>80)invalid('搜索内容过长');
  // 稀有度筛选已随卡种稀有度一起取消：旧参数返回明确错误，前端必须停止发送（不静默继续筛选）。
  if(query.rarity!==undefined&&query.rarity!=='')invalid('已取消稀有度筛选：请改用品质 / 属性 / 职业筛选');
  const affinity=enumValue('affinity',['','moon','sun','forest']);
  const role=enumValue('role',['','坦克','战士','射手','法师','刺客']);const rank=enumValue('rank',['','1','2','3','4','5']);
  const scope=enumValue('scope',['all','mine'],'all'),sort=enumValue('sort',['newest','oldest','low','high','level'],'newest');
  function amount(key){const raw=query[key];if(raw===undefined||raw==='')return null;if(typeof raw!=='string'||!/^\d{1,6}$/.test(raw))invalid('价格筛选必须是整数');const n=Number(raw);if(n<0||n>100000)invalid('价格筛选超出范围');return n;}
  const minPrice=amount('minPrice'),maxPrice=amount('maxPrice');if(minPrice!==null&&maxPrice!==null&&minPrice>maxPrice)invalid('最低价格不能高于最高价格');
  const rawPage=query.page??'1';if(typeof rawPage!=='string'||!/^\d{1,8}$/.test(rawPage)||Number(rawPage)<1)invalid('无效的市场页码');
  const search=text.trim().toLocaleLowerCase('zh-CN');
  const definitions=CARDS.filter(def=>(!search||def.name.toLocaleLowerCase('zh-CN').includes(search))&&(!affinity||def.affinity===affinity)&&(!role||getCombatStats({uid:'market-preview',defId:def.id,rank:1,best:0}).role===role));
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
  const at=now(),day=at-86400000;
  // 用解析后的卡种集合/品质作键；页码、价格、用户名、搜索文本变体不能制造无限缓存键。
  const lowestPrice=db.prepare("SELECT MIN(price) value FROM listings l WHERE l.status='active' AND "+cardWhere).get(...cardParams).value;
  const publicQuote=cached('card:'+JSON.stringify(cardParams),at,()=>{
    const soldWhere="l.status='sold' AND "+cardWhere,recentWhere=soldWhere+' AND l.closed_at>=?';
    const sales24h=db.prepare('SELECT COUNT(*) n FROM listings l WHERE '+recentWhere).get(...cardParams,day).n;
    const lastPrice=db.prepare('SELECT price FROM listings l WHERE '+soldWhere+' ORDER BY l.closed_at DESC,l.id DESC LIMIT 1').get(...cardParams)?.price??null;
    const recentTrades=db.prepare('SELECT l.* FROM listings l WHERE '+soldWhere+' ORDER BY l.closed_at DESC,l.id DESC LIMIT 20').all(...cardParams).map(row=>({id:row.id,card:JSON.parse(row.card),price:row.price,closedAt:new Date(row.closed_at).toISOString()}));
    return {quote:{medianPrice24h:median(db,recentWhere,[...cardParams,day]),lastPrice,sales24h},recentTrades};
  },true);
  // 两侧先按各自索引取 30 条，再合并最多 60 条，避免 OR 命中用户全部历史后全量排序。
  const history=db.prepare(`SELECT * FROM (
    SELECT * FROM (SELECT * FROM listings WHERE seller_id=? AND status IN ('sold','cancelled') ORDER BY closed_at DESC,id DESC LIMIT 30)
    UNION ALL
    SELECT * FROM (SELECT * FROM listings WHERE buyer_id=? AND seller_id<>? AND status IN ('sold','cancelled') ORDER BY closed_at DESC,id DESC LIMIT 30)
  ) ORDER BY closed_at DESC,id DESC LIMIT 30`).all(user.id,user.id,user.id).map(row=>({id:row.id,type:row.status==='cancelled'?'cancel':row.seller_id===user.id?'sell':'buy',card:JSON.parse(row.card),price:row.price,fee:row.status==='sold'&&row.seller_id===user.id?(row.fee??Math.floor(row.price*.05)):0,at:new Date(row.closed_at).toISOString()}));
  const global=globalMarket(at);
  return {listings,mine,page,pageSize,total,feePercent:5,stats:{...global.stats},...structuredClone(publicQuote),quote:{lowestPrice,...publicQuote.quote},quotes:global.quotes.map(q=>({...q})),history};
 };
}
