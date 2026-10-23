import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {beginGame, act, view, tick} from './game.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const rooms=new Map();
const PORT=Number(process.env.PORT||3000);
const clients=new Set();
const MAX_ROOMS=500;
const code=()=>randomBytes(4).toString('hex').toUpperCase();
const token=()=>randomBytes(24).toString('hex');
const json=(res,status,obj,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(obj));};
const failure=(res,e)=>json(res,e.status||400,{error:e.message||'操作に失敗しました'});
async function body(req){let data='';for await(const b of req){data+=b;if(data.length>16384)throw Error('データが大きすぎます');} try{return JSON.parse(data||'{}');}catch{throw Error('JSONが不正です');}}
function playerFor(room,secret){return room.players.find(p=>p.token===secret);}
function authorized(url,request,secretFallback){
  const code=url.searchParams.get('room')?.trim().toUpperCase();
  const room=rooms.get(code);
  if(!room)throw Error('ルームがありません');
  const secret=request.headers.authorization?.replace(/^Bearer\s+/i,'')||url.searchParams.get('token')||secretFallback;
  const player=playerFor(room,secret);
  if(!player)throw Error('参加認証に失敗しました');
  return {room,player};
}
function publicRoom(room,pid){
  if(!room.game)return {code:room.code,lobby:true,players:room.players.map(p=>({id:p.id,name:p.name})),selfId:pid};
  return {code:room.code,lobby:false,...view(room.game,pid)};
}
function broadcast(room){
  for(const sub of [...room.subs]) {
    try{sub.res.write(`data: ${JSON.stringify(publicRoom(room,sub.id))}\n\n`);}catch{room.subs.delete(sub);}
  }
}
function roomAction(room,fn){
  if(room.game)tick(room.game);
  const answer=fn();
  broadcast(room);return answer;
}
const routes={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/client.js':'client.js'};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,rooms:rooms.size});return;}
    if(req.method==='GET'&&routes[url.pathname]){
      const file=routes[url.pathname];
      const data=await readFile(path.join(ROOT,file));
      res.writeHead(200,{'content-type':types[path.extname(file)],'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'"});
      res.end(data);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/create'){
      if(rooms.size>=MAX_ROOMS)throw Error('ルーム数の上限に達しました');
      const data=await body(req);
      const name=String(data.name||'').trim().slice(0,20);
      if(!name)throw Error('名前を入力してください');
      let id;do{id=code();}while(rooms.has(id));
      const p={id:'p1',name,token:token()};
      const room={code:id,players:[p],game:null,subs:new Set(),lastActive:Date.now()};
      rooms.set(id,room);json(res,200,{room:id,token:p.token,playerId:p.id});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/join'){
      const data=await body(req);
      const id=String(data.room||'').trim().toUpperCase();
      const room=rooms.get(id);if(!room)throw Error('ルームが見つかりません');
      if(room.game||room.players.length>=2)throw Error('このルームはすでに満員です');
      const name=String(data.name||'').trim().slice(0,20);
      if(!name)throw Error('名前を入力してください');
      const p={id:'p2',name,token:token()};room.players.push(p);room.lastActive=Date.now();
      json(res,200,{room:id,token:p.token,playerId:p.id});broadcast(room);return;
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const {room,player}=authorized(url,req);
      if(room.game)roomAction(room,()=>null);
      json(res,200,publicRoom(room,player.id));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const {room,player}=authorized(url,req);
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
      const sub={res,id:player.id};room.subs.add(sub);
      res.write(`data: ${JSON.stringify(publicRoom(room,player.id))}\n\n`);
      const pulse=setInterval(()=>{try{if(room.game) {const moved=tick(room.game);if(moved)broadcast(room);}res.write(': ping\n\n');}catch{clearInterval(pulse);room.subs.delete(sub);}},5000);
      req.on('close',()=>{clearInterval(pulse);room.subs.delete(sub);});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/start'){
      const data=await body(req);const fakeUrl=new URL(`http://localhost/?room=${encodeURIComponent(data.room||'')}`);
      const {room,player}=authorized(fakeUrl,req,data.token);
      if(room.players[0].id!==player.id)throw Error('ルーム作成者だけが開始できます');
      if(room.players.length!==2||room.game)throw Error('2人揃った未開始のルームだけ開始できます');
      if(![1,2,3,4,5,6,7,8,9,10].includes(Number(data.minutes||3)))throw Error('議論時間は1〜10分で指定してください');
      roomAction(room,()=>{room.game=beginGame(room.players,{minutes:Number(data.minutes||3)});room.game.code=room.code;});
      json(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/action'){
      const data=await body(req);const fakeUrl=new URL(`http://localhost/?room=${encodeURIComponent(data.room||'')}`);
      const {room,player}=authorized(fakeUrl,req,data.token);
      if(!room.game)throw Error('ゲームはまだ開始していません');
      roomAction(room,()=>act(room.game,player.id,data));
      json(res,200,{ok:true});return;
    }
    json(res,404,{error:'ページが見つかりません'});
  }catch(e){failure(res,e);}
});
// Empty rooms and completed matches are temporary; free hosting may restart at any time.
const sweep=setInterval(()=>{
  const now=Date.now();for(const [id,room] of rooms){if(room.game&&tick(room.game,now))broadcast(room);
    if(now-room.lastActive>24*3600_000&&room.subs.size===0)rooms.delete(id);
  }
},5000);sweep.unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`SUPER KIRA GAME → http://localhost:${PORT}`));
export {server,rooms};
