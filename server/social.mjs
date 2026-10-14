import {randomUUID} from 'node:crypto';

function fail(status,message){const error=new Error(message);error.status=status;throw error;}
function cleanString(value,label,max=160){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(400,label+'不正确');return value.trim();}

export function createSocialService(db,options={}){
  const now=options.now??Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships(
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,friend_id),CHECK(user_id<>friend_id)
    );
    CREATE TABLE IF NOT EXISTS friend_requests(
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(sender_id,recipient_id),CHECK(sender_id<>recipient_id)
    );
    CREATE INDEX IF NOT EXISTS friend_requests_recipient ON friend_requests(recipient_id,created_at);
    CREATE TABLE IF NOT EXISTS social_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('world','private')),
      text TEXT NOT NULL,created_at INTEGER NOT NULL,
      CHECK((channel='world' AND recipient_id IS NULL) OR (channel='private' AND recipient_id IS NOT NULL AND sender_id<>recipient_id))
    );
    CREATE INDEX IF NOT EXISTS social_messages_channel ON social_messages(channel,id DESC);
    CREATE INDEX IF NOT EXISTS social_messages_participants ON social_messages(sender_id,recipient_id,id DESC);
    CREATE TABLE IF NOT EXISTS social_rates(
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,window_start INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL,
      PRIMARY KEY(user_id,kind)
    );
  `);
  function atomic(work){const name='social_'+randomUUID().replaceAll('-','');db.exec('SAVEPOINT '+name);try{const value=work();db.exec('RELEASE '+name);return value;}catch(error){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw error;}}
  function profile(user){if(!user||typeof user.id!=='string')fail(401,'请先登录');const row=db.prepare('SELECT u.id,u.name,p.code FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?').get(user.id);if(!row)fail(409,'账号资料尚未准备好，请刷新游戏');return {...row};}
  function mutual(left,right){return !!db.prepare('SELECT 1 AS ok FROM friendships a JOIN friendships b ON b.user_id=a.friend_id AND b.friend_id=a.user_id WHERE a.user_id=? AND a.friend_id=?').get(left,right);}
  function requireFriend(left,right){if(!mutual(left,right))fail(403,'只有双方已成为好友，才能私聊');}
  function throttle(userId,kind,cooldown,limit){const at=now();const current=db.prepare('SELECT * FROM social_rates WHERE user_id=? AND kind=?').get(userId,kind);if(current&&at-current.last_at<cooldown)fail(429,'操作太快，请稍后再试');const fresh=!current||at-current.window_start>=60000;const count=fresh?0:current.count;if(count>=limit)fail(429,'本分钟操作次数已用完，请稍后再试');db.prepare('INSERT INTO social_rates(user_id,kind,window_start,last_at,count) VALUES(?,?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET window_start=excluded.window_start,last_at=excluded.last_at,count=excluded.count').run(userId,kind,fresh?at:current.window_start,at,count+1);}
  function publicPerson(row){return {id:row.id,code:row.code,name:row.name};}
  function snapshot(user){const self=profile(user);const friends=db.prepare('SELECT u.id,u.name,p.code FROM friendships f JOIN friendships reverse ON reverse.user_id=f.friend_id AND reverse.friend_id=f.user_id JOIN users u ON u.id=f.friend_id JOIN profiles p ON p.user_id=u.id WHERE f.user_id=? ORDER BY u.name,u.id').all(self.id).map(publicPerson);const incoming=db.prepare('SELECT u.id,u.name,p.code FROM friend_requests r JOIN users u ON u.id=r.sender_id JOIN profiles p ON p.user_id=u.id WHERE r.recipient_id=? ORDER BY r.created_at,r.sender_id').all(self.id).map(publicPerson);const outgoing=db.prepare('SELECT u.id,u.name,p.code FROM friend_requests r JOIN users u ON u.id=r.recipient_id JOIN profiles p ON p.user_id=u.id WHERE r.sender_id=? ORDER BY r.created_at,r.recipient_id').all(self.id).map(publicPerson);return {self:publicPerson(self),friends,incoming,outgoing};}
  function channelFor(user,channel){const value=cleanString(channel,'聊天频道');if(value==='world')return value;if(value===user.id)fail(400,'不能给自己发送私聊');requireFriend(user.id,value);return value;}
  function messageRow(row){return {id:String(row.id),senderId:row.sender_id,senderName:row.sender_name,text:row.text,at:row.created_at};}
  function messages(user,channel='world'){const self=profile(user);const target=channelFor(self,channel);const rows=target==='world'?db.prepare("SELECT m.*,u.name AS sender_name FROM social_messages m JOIN users u ON u.id=m.sender_id WHERE m.channel='world' ORDER BY m.id DESC LIMIT 50").all():db.prepare("SELECT m.*,u.name AS sender_name FROM social_messages m JOIN users u ON u.id=m.sender_id WHERE m.channel='private' AND ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?)) ORDER BY m.id DESC LIMIT 50").all(self.id,target,target,self.id);return rows.reverse().map(messageRow);}
  function execute(user,action,input={}){const self=profile(user);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'请求内容不正确');return atomic(()=>{
    if(action==='friend.request'){
      const code=cleanString(input.code,'好友码',64).toUpperCase();const target=db.prepare('SELECT u.id,u.name,p.code FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.code=?').get(code);
      if(!target)fail(404,'没有找到这个好友码');if(target.id===self.id)fail(400,'不能添加自己');if(mutual(self.id,target.id))fail(409,'你们已经是好友');
      if(db.prepare('SELECT 1 FROM friend_requests WHERE sender_id=? AND recipient_id=?').get(self.id,target.id))fail(409,'好友申请已发送，等待对方处理');
      if(db.prepare('SELECT 1 FROM friend_requests WHERE sender_id=? AND recipient_id=?').get(target.id,self.id))fail(409,'对方已申请添加你，请在收到的申请中接受');
      if(db.prepare('SELECT COUNT(*) AS count FROM friendships WHERE user_id=?').get(self.id).count>=200)fail(409,'好友数量已达 200 人上限');
      if(db.prepare('SELECT COUNT(*) AS count FROM friend_requests WHERE recipient_id=?').get(target.id).count>=200)fail(409,'对方待处理申请较多，请稍后再试');
      throttle(self.id,'friend',3000,10);db.prepare('INSERT INTO friend_requests VALUES(?,?,?)').run(self.id,target.id,now());return {ok:true};
    }
    if(['friend.accept','friend.decline','friend.remove'].includes(action)){
      const other=cleanString(input.userId,'玩家 ID');if(other===self.id)fail(400,'不能对自己执行此操作');
      if(action==='friend.remove'){db.prepare('DELETE FROM friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)').run(self.id,other,other,self.id);db.prepare('DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)').run(self.id,other,other,self.id);return {ok:true};}
      if(!db.prepare('SELECT 1 FROM friend_requests WHERE sender_id=? AND recipient_id=?').get(other,self.id))fail(404,'这条好友申请已不存在');
      if(action==='friend.accept'){
        for(const id of [self.id,other])if(db.prepare('SELECT COUNT(*) AS count FROM friendships WHERE user_id=?').get(id).count>=200)fail(409,'其中一方的好友数量已达上限');
        const add=db.prepare('INSERT OR IGNORE INTO friendships VALUES(?,?,?)');add.run(self.id,other,now());add.run(other,self.id,now());
      }
      db.prepare('DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)').run(self.id,other,other,self.id);return {ok:true};
    }
    if(action==='chat.send'){
      const target=channelFor(self,input.channel);if(typeof input.text!=='string')fail(400,'消息必须是纯文本');const text=input.text.trim();
      if(!text||[...text].length>300)fail(400,'消息需为 1–300 个字');if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))fail(400,'消息包含不支持的控制字符');
      throttle(self.id,'chat',1200,20);const at=now();const result=db.prepare('INSERT INTO social_messages(sender_id,recipient_id,channel,text,created_at) VALUES(?,?,?,?,?)').run(self.id,target==='world'?null:target,target==='world'?'world':'private',text,at);
      return {ok:true,message:{id:String(result.lastInsertRowid),senderId:self.id,senderName:self.name,text,at}};
    }
    fail(400,'不支持的社交操作');
  });}
  function adminStats(){return {friendships:db.prepare('SELECT COUNT(*) AS n FROM friendships a JOIN friendships b ON b.user_id=a.friend_id AND b.friend_id=a.user_id WHERE a.user_id<a.friend_id').get().n,worldMessages:db.prepare("SELECT COUNT(*) AS n FROM social_messages WHERE channel='world'").get().n,privateMessages:db.prepare("SELECT COUNT(*) AS n FROM social_messages WHERE channel='private'").get().n,pendingRequests:db.prepare('SELECT COUNT(*) AS n FROM friend_requests').get().n};}
  return {snapshot,execute,messages,adminStats};
}
