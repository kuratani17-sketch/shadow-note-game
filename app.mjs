import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';

// Game engine: same rules and privacy-preserving state as the verified version.

const ROLES = Object.freeze(['kira', 'devotee', 'l', 'investigator', 'investigator']);
const NPC_NAMES = Object.freeze(['夜神', '竜崎', '相沢', '模木', '松田', 'ワタリ', '渋井丸']);
const PHASE_SECONDS = Object.freeze({ note_setup: 45, role_reveal: 45, discussion: 180, mission_selection: 45, night: 90, night_review: 20 });
const DEFAULT_SETTINGS = Object.freeze({ discussionSeconds: 180, nightSeconds: 90 });
const LIMITS = Object.freeze({discussionSeconds: [30, 1800], nightSeconds: [15, 600]});
function parseSettings(data) {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = data[key] == null ? DEFAULT_SETTINGS[key] : Number(data[key]);
    const [min,max] = LIMITS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Object.assign(new Error(`${key === 'discussionSeconds' ? '議論' : '夜'}の時間は${min}〜${max}秒で指定してください`), {status:400});
    settings[key] = value;
  }
  return settings;
}
const ROLE_LABELS = Object.freeze({ kira: 'キラ', devotee: '崇拝者', l: 'L', investigator: '捜査員' });
const FACTION_LABELS = Object.freeze({ kira: 'キラ陣営', l: 'L陣営' });
const ACTION_LABELS = Object.freeze({ none: '何もしない', judge: '裁き', transfer: 'ノートの受け渡し', investigate: '調査', observe: '観察', infer: '推理', search: '捜査', raid: '突入' });

function choose(items, random = randomInt) { return items[random(items.length)]; }
function shuffle(xs, random = randomInt) {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function faction(role) { return role === 'kira' || role === 'devotee' ? 'kira' : 'l'; }
function charByRole(g, role) { return g.characters.find(c => c.role === role); }
function charById(g, id) { return g.characters.find(c => c.id === id); }
function playerCharacter(g, playerId) { return g.characters.find(c => c.playerId === playerId); }
function knowledge(g, id) { return g.knowledge[id]; }
function addMessage(g, charId, msg) {
  if (!g.knowledge[charId]) return;
  g.knowledge[charId].messages.push({ round: g.round, message: msg });
}
function addRole(g, observerId, target) { knowledge(g, observerId).roles[target.id] = target.role; }
function addFaction(g, observerId, target) { knowledge(g, observerId).factions[target.id] = target.faction; }
function setPhase(g, phase, now, duration = phase === 'discussion' ? g.settings.discussionSeconds : phase === 'night' ? g.settings.nightSeconds : PHASE_SECONDS[phase]) {
  g.phase = phase;
  g.deadline = duration ? now + duration * 1000 : null;
}

function newGame(players, now = Date.now(), random = randomInt, settings = DEFAULT_SETTINGS) {
  if (players.length !== 2) throw new Error('2人揃ってから開始してください');
  const npcNames = shuffle(NPC_NAMES, random).slice(0, 3);
  // Rejection sampling gives uniform distribution across the permitted player role assignments.
  let roles;
  do { roles = shuffle(ROLES, random); }
  while (roles[0] === 'kira' && roles[1] === 'devotee' || roles[0] === 'devotee' && roles[1] === 'kira');
  const characters = roles.map((role, i) => ({
    id: `c${i}`, role, faction: faction(role),
    displayName: i < 2 ? players[i].name : npcNames[i - 2],
    isNPC: i >= 2,
    playerId: i < 2 ? players[i].id : null
  }));
  const leaderPlayerId = players[random(2)].id;
  const g = {
    round: 1, phase: 'discussion', deadline: null, leaderPlayerId, settings: {...settings}, nightEndRequests: [],
    characters, knowledge: {}, noteHolderId: null, pendingNoteHolderId: null,
    missionMembers: [], missionVotes: {}, missionSuccessCount: 0,
    missionHistory: [], revealedOnce: false, revealedNPC: null,
    actions: {}, winner: null, reason: '', nightReviewReady: [], gameEvents: [],
    lastPublicMission: null
  };
  for (const c of characters) {
    g.knowledge[c.id] = { names: [], roles: {[c.id]: c.role}, factions: {[c.id]: c.faction}, notKira: [], noteChecks: {}, messages: [] };
  }
  const kira = charByRole(g, 'kira');
  const devotee = charByRole(g, 'devotee');
  addRole(g, devotee.id, kira);
  addMessage(g, devotee.id, `キラは「${kira.displayName}」です。`);
  for (const c of characters.filter(c => c.role === 'investigator')) {
    const npc = choose(characters.filter(n => n.isNPC && n.role !== 'kira'), random);
    knowledge(g, c.id).notKira.push(npc.id);
    addMessage(g, c.id, `初期情報：「${npc.displayName}」はキラではありません。`);
  }
  if (!kira.isNPC) {
    setPhase(g, 'note_setup', now);
  } else {
    g.noteHolderId = !devotee.isNPC ? kira.id : choose([kira.id, devotee.id], random);
    beginDiscussion(g, now);
  }
  return g;
}

function beginDiscussion(g, now) { setPhase(g, 'discussion', now); }
function beginMissionOrNight(g, now, random = randomInt) {
  if (g.round === 4 || g.missionSuccessCount >= 2) {
    g.missionMembers = [];
    startNight(g, now);
  } else {
    setPhase(g, 'mission_selection', now);
  }
}
function beginNextRound(g, now, random = randomInt) {
  g.round++;
  const ids = g.characters.filter(c => !c.isNPC).map(c => c.playerId);
  g.leaderPlayerId = ids.find(x => x !== g.leaderPlayerId);
  if (g.pendingNoteHolderId) g.noteHolderId = g.pendingNoteHolderId;
  g.pendingNoteHolderId = null;
  g.actions = {};
  g.nightEndRequests = [];
  g.missionVotes = {};
  g.missionMembers = [];
  g.nightReviewReady = [];
  g.lastPublicMission = g.missionHistory.find(h => h.round === g.round - 1) ?? null;
  if (g.missionSuccessCount >= 2 && !g.revealedOnce) {
    setPhase(g, 'role_reveal', now);
  } else {
    beginDiscussion(g, now);
  }
}
function validMission(g, ids) {
  return Array.isArray(ids) && ids.length === 2 &&
    new Set(ids).size === 2 && ids.every(id => !!charById(g, id)) &&
    ids.some(id => charById(g, id).isNPC);
}
function startNight(g, now) {
  g.nightEndRequests = [];
  g.actions = {};
  g.missionVotes = {};
  setPhase(g, 'night', now);
  const devotee = charByRole(g, 'devotee');
  if (g.missionMembers.includes(devotee.id)) {
    const otherId = g.missionMembers.find(id => id !== devotee.id);
    const other = charById(g, otherId);
    const kira = charByRole(g, 'kira');
    for (const id of [devotee.id, kira.id]) {
      const names = knowledge(g, id).names;
      if (!names.includes(otherId)) names.push(otherId);
    }
    addRole(g, kira.id, devotee);
    addMessage(g, devotee.id, `死神の目：「${other.displayName}」の本名を知りました。`);
    addMessage(g, kira.id, `崇拝者は「${devotee.displayName}」です。死神の目で「${other.displayName}」の本名を知り、あなたと共有しました。`);
  }
}
function requireTarget(g, id, field) {
  if (typeof id !== 'string' || !charById(g, id)) throw new Error(`${field}を選択してください`);
  return charById(g, id);
}
function requireDistinctTargets(g, a, b) {
  const t1 = requireTarget(g, a, '対象1');
  const t2 = requireTarget(g, b, '対象2');
  if (a === b) throw new Error('同じ人物を2回指定できません');
  return [t1, t2];
}
function availableActions(g, c) {
  if (g.phase !== 'night') return [];
  switch (c.role) {
    case 'kira': return [ 'none', ...(g.round < 4 ? ['transfer'] : []), ...(g.round >= 3 && g.noteHolderId === c.id && knowledge(g,c.id).names.some(id => id !== c.id) ? ['judge'] : []) ];
    case 'devotee': return ['none', ...(g.round < 4 ? ['transfer'] : [])];
    case 'l': return [ 'none', ...(g.round < 4 ? ['investigate'] : []), ...(g.round < 4 && g.missionMembers.includes(c.id) ? ['observe'] : []), ...(g.round >= 3 ? ['infer'] : []) ];
    case 'investigator': return [ 'none', ...(g.round < 4 ? ['search'] : []), ...(g.round >= 3 ? ['raid'] : []) ];
    default: return ['none'];
  }
}

function performAction(g, playerId, type, data = {}, now = Date.now(), random = randomInt) {
  if (g.phase === 'finished') throw new Error('ゲームは終了しています');
  const self = playerCharacter(g, playerId);
  if (!self) throw new Error('プレイヤーが見つかりません');
  switch(type) {
    case 'note_choice': {
      if (g.phase !== 'note_setup' || self.role !== 'kira') throw new Error('ノートを選択できません');
      if (!['kira','devotee'].includes(data.holder)) throw new Error('所持者を選択してください');
      g.noteHolderId = charByRole(g, data.holder).id;
      addMessage(g, self.id, `初期ノート所持者を「${ROLE_LABELS[data.holder]}」に設定しました。`);
      beginDiscussion(g, now);
      break;
    }
    case 'reveal': {
      if (g.phase !== 'role_reveal' || g.leaderPlayerId !== playerId) throw new Error('リーダーのみ指定できます');
      const target = requireTarget(g, data.target, '公開対象');
      if (!target.isNPC) throw new Error('NPCから選んでください');
      doReveal(g, target.id, now);
      break;
    }
    case 'end_discussion': {
      if (g.phase !== 'discussion' || g.leaderPlayerId !== playerId) throw new Error('リーダーのみ議論を終了できます');
      beginMissionOrNight(g, now, random);
      break;
    }
    case 'mission_select': {
      if (g.phase !== 'mission_selection' || g.leaderPlayerId !== playerId) throw new Error('リーダーのみ任務を選出できます');
      if (!validMission(g, data.members)) throw new Error('NPCを最低1人含め、異なる2人を選択してください');
      g.missionMembers = [...data.members];
      startNight(g, now);
      break;
    }
    case 'night_action': {
      if (g.phase !== 'night') throw new Error('今は夜ではありません');
      if (g.actions[playerId]) throw new Error('この夜の行動は確定済みです');
      const voteNeeded = g.missionMembers.includes(self.id);
      if (voteNeeded && !['success','failure'].includes(data.missionVote)) throw new Error('任務の成功・失敗を選択してください');
      if (!voteNeeded && data.missionVote != null) throw new Error('任務に参加していません');
      const ability = data.ability || 'none';
      if (!availableActions(g, self).includes(ability)) throw new Error('この能力は使用できません');
      const target = data.target, target2 = data.target2;
      if (ability === 'judge') {
        const t = requireTarget(g, target, '裁く人物');
        if (!knowledge(g, self.id).names.includes(t.id) || t.id === self.id) throw new Error('本名を知らない人物は裁けません');
      }
      if (ability === 'investigate') {
        const t = requireTarget(g, target, '調査する人物');
        addFaction(g, self.id, t);
        addMessage(g, self.id, `調査結果：「${t.displayName}」は${FACTION_LABELS[t.faction]}です。`);
      }
      if (ability === 'observe') {
        const otherId = g.missionMembers.find(id => id !== self.id);
        if (!otherId) throw new Error('任務の相手がいません');
        const t = charById(g, otherId);
        addRole(g, self.id, t);
        addMessage(g, self.id, `観察結果：「${t.displayName}」の役職は${ROLE_LABELS[t.role]}です。`);
      }
      if (ability === 'search') {
        const t = requireTarget(g, target, '捜査するNPC');
        if (!t.isNPC) throw new Error('捜査できるのはNPCだけです');
        const holding = g.noteHolderId === t.id;
        knowledge(g,self.id).noteChecks[t.id] = { round: g.round, holding };
        addMessage(g, self.id, `捜査結果：第${g.round}ラウンド、「${t.displayName}」はノートを${holding ? '所持しています' : '所持していません'}。`);
      }
      if (ability === 'infer' || ability === 'raid') requireDistinctTargets(g, target, target2);
      if (voteNeeded) g.missionVotes[self.id] = data.missionVote;
      g.actions[playerId] = { ability, target: target ?? null, target2: target2 ?? null };
      if (Object.keys(g.actions).length === 2) finalizeNight(g, now);
      break;
    }
    case 'request_night_end': {
      if (g.phase !== 'night') throw new Error('現在は夜ではありません');
      if (!g.nightEndRequests.includes(playerId)) g.nightEndRequests.push(playerId);
      if (g.nightEndRequests.length === 2) finalizeNight(g, now);
      break;
    }
    case 'night_review_ready': {
      if (g.phase !== 'night_review') throw new Error('現在は確認フェーズではありません');
      if (!g.nightReviewReady.includes(playerId)) g.nightReviewReady.push(playerId);
      if (g.nightReviewReady.length === 2) beginNextRound(g, now, random);
      break;
    }
    default: throw new Error('不明な操作です');
  }
  return g;
}
function doReveal(g, targetId, now) {
  const target = charById(g, targetId);
  g.revealedOnce = true;
  g.revealedNPC = target.id;
  g.gameEvents.push({round:g.round, message:`役職公開：「${target.displayName}」は${ROLE_LABELS[target.role]}です。`});
  beginDiscussion(g, now);
}
function autoMission(g, random) {
  // All legal pairs, uniformly selected if leader does not act.
  const candidates = [];
  const chars = g.characters;
  for (let i=0; i<chars.length; i++) for (let j=i+1; j<chars.length; j++) {
    const duo = [chars[i].id, chars[j].id];
    if (validMission(g, duo)) candidates.push(duo);
  }
  return choose(candidates, random);
}
function finalizeNight(g, now) {
  if (g.phase !== 'night') return;
  const kira = charByRole(g, 'kira');
  const devotee = charByRole(g, 'devotee');
  const l = charByRole(g, 'l');
  let kiraWin = false, lWin = false;
  let kiraReason = '', lReason = '';
  if (g.missionMembers.length) {
    let allSuccess = true;
    for (const id of g.missionMembers) {
      const c = charById(g, id);
      const choice = c.isNPC ? (c.faction === 'kira' ? 'failure' : 'success') : (g.missionVotes[id] ?? 'failure');
      if (choice !== 'success') allSuccess = false;
    }
    if (allSuccess) g.missionSuccessCount++;
    g.missionHistory.push({round: g.round, memberIds:[...g.missionMembers], success:allSuccess});
  }
  const actionsByRole = (role) => {
    const c = charByRole(g, role);
    return c.isNPC ? null : g.actions[c.playerId];
  };
  const kiraAction = actionsByRole('kira');
  const lAction = actionsByRole('l');
  const invActions = g.characters.filter(c => c.role === 'investigator' && !c.isNPC).map(c => g.actions[c.playerId]);
  // All judgments resolve against the current round's note holder (before transfers).
  if (g.round >= 3 && g.noteHolderId === kira.id) {
    if (kira.isNPC) {
      if (knowledge(g,kira.id).names.includes(l.id)) {
        kiraWin = true; kiraReason = 'NPCキラがLの本名を知り、裁きを実行した';
      }
    } else if (kiraAction?.ability === 'judge' && kiraAction.target === l.id) {
      kiraWin = true; kiraReason = 'キラの裁きがLに命中した';
    }
  }
  const raidByOtherPlayer = g.characters.some(c => c.role === 'investigator' && !c.isNPC && g.actions[c.playerId]?.ability === 'raid');
  if (lAction?.ability === 'infer') {
    if (lAction.target === kira.id && lAction.target2 === devotee.id && !raidByOtherPlayer) {
      lWin = true; lReason = 'Lの推理がキラと崇拝者の両方に正解した';
    } else {
      addMessage(g, l.id, '推理は成功しませんでした。');
    }
  }
  for (const c of g.characters.filter(c => c.role === 'investigator' && !c.isNPC)) {
    const action = g.actions[c.playerId];
    if (action?.ability !== 'raid') continue;
    const otherPlayer = g.characters.find(p => !p.isNPC && p.playerId !== c.playerId);
    const otherInvestigator = g.characters.find(p => p.role === 'investigator' && p.id !== c.id);
    if (otherPlayer.role !== 'l' && action.target === g.noteHolderId && action.target2 === otherInvestigator.id) {
      lWin = true; lReason = '捜査員の突入がノート所持者ともう1人の捜査員に正解した';
    } else {
      addMessage(g, c.id, '突入は成功しませんでした。');
    }
  }
  if (g.round < 4) {
    for (const c of g.characters.filter(c => !c.isNPC)) {
      if (g.actions[c.playerId]?.ability === 'transfer') {
        g.pendingNoteHolderId = g.noteHolderId === kira.id ? devotee.id : kira.id;
        addMessage(g, c.id, `ノートの受け渡しを予約しました。第${g.round + 1}ラウンドから反映されます。`);
      }
    }
  }
  if (kiraWin || lWin || g.round === 4) {
    g.winner = kiraWin && lWin ? 'draw' : kiraWin ? 'kira' : lWin ? 'l' : 'kira';
    g.reason = kiraWin && lWin ? `${kiraReason}。同時に${lReason}ため引き分け。` : kiraWin ? kiraReason : lWin ? lReason : '4ラウンド終了時点でL陣営の勝利条件を達成できなかった';
    setPhase(g, 'finished', now);
    return;
  }
  setPhase(g, 'night_review', now);
}

function tick(g, now = Date.now(), random = randomInt) {
  if (g.phase === 'finished' || g.deadline == null || now < g.deadline) return false;
  switch(g.phase) {
    case 'note_setup':
      g.noteHolderId = charByRole(g, 'kira').id;
      addMessage(g, g.noteHolderId, '時間切れのため、初期ノート所持者はキラになりました。');
      beginDiscussion(g, now); break;
    case 'role_reveal': {
      const target = choose(g.characters.filter(c => c.isNPC), random);
      doReveal(g, target.id, now); break;
    }
    case 'discussion': beginMissionOrNight(g, now, random); break;
    case 'mission_selection':
      g.missionMembers = autoMission(g, random);
      startNight(g, now); break;
    case 'night': finalizeNight(g, now); break;
    case 'night_review': beginNextRound(g, now, random); break;
    default: return false;
  }
  return true;
}

function viewFor(g, playerId) {
  const self = playerCharacter(g, playerId);
  if (!self) throw new Error('プレイヤーではありません');
  const k = knowledge(g, self.id);
  const gameDone = g.phase === 'finished';
  const notePersonal = (self.role === 'kira' || self.role === 'devotee') && g.noteHolderId != null
    ? (g.noteHolderId === self.id ? '自分が所持' : g.noteHolderId === charByRole(g,'kira').id ? 'キラが所持' : '崇拝者が所持') : null;
  return {
    round: g.round, phase: g.phase, deadline: g.deadline, settings: {...g.settings},
    nightEndCount: g.nightEndRequests.length, myNightEndRequested: g.nightEndRequests.includes(playerId),
    leaderPlayerId: g.leaderPlayerId, isLeader: g.leaderPlayerId === playerId,
    myId: self.id, myRole: self.role, myFaction: self.faction,
    notePersonal, availableActions: availableActions(g, self),
    missionMembers: [...g.missionMembers], missionSuccessCount: g.missionSuccessCount,
    // Only disclose missions whose result has been announced at the start of a later round.
    // Do not leak the ongoing night's result through a real-time snapshot.
    missionHistory: g.missionHistory.filter(m => gameDone || m.round < g.round).map(m => ({
      round: m.round, memberIds: [...m.memberIds], success: m.success
    })),
    lastPublicMission: g.lastPublicMission ? {round:g.lastPublicMission.round,success:g.lastPublicMission.success} : null,
    revealedOnce: g.revealedOnce, revealedNPC: g.revealedNPC,
    publicEvents: [...g.gameEvents],
    myActionSubmitted: !!g.actions[playerId],
    otherActionSubmitted: g.characters.some(c => !c.isNPC && c.playerId !== playerId && !!g.actions[c.playerId]),
    reviewReady: g.nightReviewReady.includes(playerId),
    myKnowledge: {
      names: [...k.names], roles: {...k.roles}, factions: {...k.factions},
      notKira: [...k.notKira], noteChecks: {...k.noteChecks},
      messages: [...k.messages]
    },
    characters: g.characters.map(c => ({
      id: c.id, displayName:c.displayName, isNPC:c.isNPC,
      isMe:c.id === self.id, isLeader: !c.isNPC && c.playerId === g.leaderPlayerId,
      publicRole: gameDone ? c.role : (g.revealedNPC === c.id ? c.role : null),
      finalRole: gameDone ? c.role : undefined
    })),
    winner: gameDone ? g.winner : null, reason: gameDone ? g.reason : null,
    finalNoteHolderId: gameDone ? g.noteHolderId : null
  };
}

function spectatorView(g) {
  const done = g.phase === 'finished';
  return {
    round: g.round, phase: g.phase, deadline: g.deadline,
    leaderPlayerId: g.leaderPlayerId, settings: {...g.settings},
    missionMembers: [...g.missionMembers], missionSuccessCount: g.missionSuccessCount,
    missionHistory: g.missionHistory.filter(m => done || m.round < g.round).map(m => ({round:m.round,memberIds:[...m.memberIds],success:m.success})),
    publicEvents: [...g.gameEvents],
    noteHolderId: g.noteHolderId,
    characters: g.characters.map(c=>({id:c.id,displayName:c.displayName,isNPC:c.isNPC,role:c.role,faction:c.faction,
       isLeader:!c.isNPC && c.playerId === g.leaderPlayerId,
       actionSubmitted:!c.isNPC && !!g.actions[c.playerId]})),
    winner: done ? g.winner : null, reason: done ? g.reason : null
  };
}

function validateEngine(g) {
  if (!['note_setup','discussion','mission_selection','role_reveal','night','night_review','finished'].includes(g.phase)) throw new Error('invalid phase');
  if (g.round < 1 || g.round > 4) throw new Error('invalid round');
  if (g.characters.length !== 5) throw new Error('invalid cast');
  if (g.characters.filter(c=>!c.isNPC).length !== 2) throw new Error('invalid player count');
  if (g.missionMembers.length && !validMission(g, g.missionMembers)) throw new Error('invalid mission members');
  return true;
}

// HTTP + SSE server and the bundled mobile interface.
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const rooms = new Map();
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const embeddedAssets = new Map(Object.entries({"client.js":"'use strict';\nconst STORAGE_KEY='super-kira-game-player-session-v1';\nconst app=document.getElementById('app');\nconst toast=document.getElementById('toast');\nconst netStatus=document.getElementById('netStatus');\nconst roomTag=document.getElementById('roomTag');\nconst ROLE={kira:'キラ',devotee:'崇拝者',l:'L',investigator:'捜査員'};\nconst ABILITY={none:'何もしない',judge:'裁き',transfer:'ノートの受け渡し',investigate:'調査',observe:'観察',infer:'推理',search:'捜査',raid:'突入'};\nconst ABILITY_DESC={none:'特殊能力は使いません。',judge:'本名を知っている人物を裁きます。相手がLなら勝利。',transfer:'ノートの所持者を次のラウンドから変更します。',investigate:'選んだ人物の所属陣営が分かります。',observe:'任務の相手の正確な役職が分かります。',infer:'キラと崇拝者を両方当てると勝利。ただし妨害条件に注意。',search:'NPCが現在ノートを持っているか調べます。',raid:'ノート所持者ともう1人の捜査員を当てると勝利。ただし妨害条件に注意。'};\nconst PHASE={note_setup:'ノート所持者の決定',role_reveal:'NPCの役職公開',discussion:'昼・議論',mission_selection:'昼・任務参加者選出',night:'夜・秘密行動',night_review:'夜・情報確認',finished:'ゲーム終了'};\nlet session=null, source=null, snapshot=null, draft={}, phaseKey='', busy=false;\nconst params=new URLSearchParams(location.search);\nlet suggestedRoom=(params.get('room')||'').trim().toUpperCase();\nconst watchRoom=(params.get('watch')||'').trim().toUpperCase();\nconst watchKey=(params.get('key')||'').trim();\n\nfunction esc(x){return String(x??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}\nfunction showError(x){toast.textContent=String(x);if(x)window.scrollTo({top:0,behavior:'smooth'});}\nfunction remember(s){session=s;localStorage.setItem(STORAGE_KEY,JSON.stringify(s));}\nfunction resetSession(){if(source){source.close();source=null;}session=null;snapshot=null;localStorage.removeItem(STORAGE_KEY);netStatus.textContent='オフライン';netStatus.className='';roomTag.textContent='';render();}\nfunction roomUrl(code){return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;}\nfunction spectatorUrl(code,key){return `${location.origin}${location.pathname}?watch=${encodeURIComponent(code)}&key=${encodeURIComponent(key)}`;}\nasync function api(path,data){\n  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});\n  const body=await response.json().catch(()=>({error:'通信エラー'}));\n  if(!response.ok)throw new Error(body.error||`エラー ${response.status}`);\n  return body;\n}\nfunction init(){\n  if(watchRoom && watchKey){\n    app.innerHTML='<div class=\"panel\">観戦モードに接続しています…</div>';\n    const watchSessionKey=`super-kira-spectator-${watchRoom}`;\n    const savedToken=sessionStorage.getItem(watchSessionKey)||'';\n    api(`/api/rooms/${watchRoom}/spectate`,{key:watchKey,token:savedToken}).then(data=>{\n      sessionStorage.setItem(watchSessionKey,data.token);\n      session={...data,isSpectator:true};connect();\n    }).catch(e=>showError(`観戦できません：${e.message}`));\n    setInterval(updateClock,250);\n    return;\n  }\n  try{session=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');}catch{session=null;}\n  if(session && suggestedRoom && suggestedRoom!==session.code){session=null;localStorage.removeItem(STORAGE_KEY);}\n  if(session && session.code && session.token){connect();}else{session=null;render();}\n  setInterval(updateClock,250);\n}\nfunction connect(){\n  if(source){source.close();source=null;}\n  if(!session)return;\n  const code=session.code;\n  roomTag.textContent=`ROOM ${code}`;\n  netStatus.textContent='接続中…';netStatus.className='';\n  source=new EventSource(`/api/rooms/${encodeURIComponent(code)}/events?token=${encodeURIComponent(session.token)}`);\n  source.addEventListener('open',()=>{netStatus.textContent='● オンライン';netStatus.className='online';});\n  source.addEventListener('snapshot',e=>{\n    try{\n      snapshot=JSON.parse(e.data);\n      showError('');\n      const g=snapshot.game;\n      const key=g?`${g.round}:${g.phase}:${g.missionMembers.join(',')}`:'lobby';\n      if(key!==phaseKey){draft={missionIds:[],ability:'none',target:'',target2:'',missionVote:''};phaseKey=key;}\n      render();\n    }catch(ex){console.error(ex);}\n  });\n  source.onerror=()=>{netStatus.textContent='● 再接続中…';netStatus.className='';};\n  fetch(`/api/rooms/${encodeURIComponent(code)}/state?token=${encodeURIComponent(session.token)}`)\n    .then(r=>{if(r.status===403||r.status===404){resetSession();showError('参加情報が無効になりました。再度ルームを作成・参加してください。');}}).catch(()=>{});\n  render();\n}\nfunction updateClock(){\n  const el=document.getElementById('clock');\n  const deadline=snapshot?.game?.deadline;\n  if(!el||!deadline)return;\n  const remain=Math.max(0,Math.ceil((deadline-Date.now())/1000));\n  el.textContent=`${String(Math.floor(remain/60)).padStart(2,'0')}:${String(remain%60).padStart(2,'0')}`;\n  el.classList.toggle('danger',remain<=15);\n}\nfunction heading(text,description=''){return `<h2 class=\"title\">${esc(text)}</h2>${description?`<p class=\"muted small\">${esc(description)}</p>`:''}`;}\nfunction btn(label,action='submit',cls=''){return `<button type=\"button\" class=\"btn ${cls}\" data-action=\"${esc(action)}\">${esc(label)}</button>`;}\nfunction tag(text,cls=''){return `<span class=\"tag ${cls}\">${esc(text)}</span>`;}\nfunction lobbyScreen(){\n  const ps=snapshot.players;\n  return `<div class=\"panel\">${heading('待機ルーム','2人が揃うとゲームを開始できます。')}\n    <div class=\"subpanel\"><div class=\"label\">ルームコード</div><div class=\"title\" style=\"letter-spacing:.15em;margin:5px 0\">${esc(snapshot.code)}</div>\n    <div class=\"btnrow\">${btn('招待URLをコピー','copy-url','secondary')}${snapshot.spectatorKey?btn('観戦URLをコピー','copy-watch','secondary'):''}</div></div>\n    <p class=\"help\">観戦URLは役職をすべて見られる専用リンクです。プレイヤーには共有しないでください。</p>\n    <div class=\"subpanel\">設定：議論 ${snapshot.settings.discussionSeconds}秒・夜 ${snapshot.settings.nightSeconds}秒 ／ 観戦者 ${snapshot.spectatorCount}人</div>\n    <div class=\"section-title\">参加者 ${ps.length}/2</div>\n    ${ps.map(p=>`<div class=\"subpanel row between\"><span class=\"strong\">${esc(p.name)} ${p.id===snapshot.selfId?tag('あなた','green'):''}</span>${tag(p.connected?'接続中':'準備中',p.connected?'green':'')}</div>`).join('')}\n    ${snapshot.isHost?`<div class=\"btnrow\">${ps.length===2?btn('ゲームを開始する','start','full'):`<button class=\"btn full\" disabled>もう1人の参加を待っています</button>`}</div>`:'<p class=\"help\">ホストが開始するまでお待ちください。</p>'}\n    <div class=\"btnrow\">${btn('このルームから退出する','leave','secondary')}</div>\n  </div><div class=\"panel\"><div class=\"title-sm\">遊び方</div><p class=\"small muted\">5つの役職を2人とNPC3人に配り、最大4ラウンドで競う正体隠蔽ゲームです。会話はDiscordなどを使用してください。</p></div>`;\n}\nfunction homeScreen(){\n  return `<div class=\"panel hero\"><h1 class=\"title\">2人だけの、秘密の対決。</h1><p class=\"muted\">役職を隠し、任務と夜の能力を駆使して勝利を目指そう。</p></div>\n  <div class=\"two-col\"><div class=\"panel\"><div class=\"title-sm\">新しいルーム</div><form id=\"createForm\">\n   <label class=\"label\" for=\"createName\">ハンドルネーム（16文字以内）</label><input class=\"input\" id=\"createName\" name=\"name\" maxlength=\"16\" autocomplete=\"nickname\" placeholder=\"例：ユウ\" required>\n   <label class=\"label\" for=\"discussionSeconds\">議論時間（秒・30〜1800）</label><input class=\"input\" id=\"discussionSeconds\" name=\"discussionSeconds\" type=\"number\" min=\"30\" max=\"1800\" step=\"1\" value=\"180\" required>\n   <label class=\"label\" for=\"nightSeconds\">夜の時間（秒・15〜600）</label><input class=\"input\" id=\"nightSeconds\" name=\"nightSeconds\" type=\"number\" min=\"15\" max=\"600\" step=\"1\" value=\"90\" required>\n   <button type=\"submit\" class=\"btn full\">ルームを作成</button></form></div>\n   <div class=\"panel\"><div class=\"title-sm\">ルームに参加</div><form id=\"joinForm\"><label class=\"label\" for=\"joinName\">ハンドルネーム</label>\n   <input class=\"input\" id=\"joinName\" name=\"name\" maxlength=\"16\" autocomplete=\"nickname\" placeholder=\"例：レン\" required>\n   <label class=\"label\" for=\"joinCode\">6桁のルームコード</label><input class=\"input\" id=\"joinCode\" name=\"code\" maxlength=\"6\" autocapitalize=\"characters\" value=\"${esc(suggestedRoom)}\" placeholder=\"ABC123\" required>\n   <button type=\"submit\" class=\"btn secondary full\">参加する</button></form></div></div>\n   <div class=\"panel\"><div class=\"title-sm\">ゲームの流れ</div><div class=\"notes\">役職配布 → 昼の議論・リーダーによる任務選出 → 夜の能力使用 → 情報公開・勝利判定。<br>議論はリーダーが手動終了可能。制限時間になれば自動進行します。</div></div>`;\n}\nfunction personLabel(c,g){return `${c.displayName}${c.isMe?'（あなた）':c.isNPC?'（NPC）':'（プレイヤー）'}`;}\nfunction castScreen(g){\n  const k=g.myKnowledge;\n  return `<div class=\"panel\"><div class=\"row between\"><div class=\"title-sm\">登場人物</div>${tag('全5名')}</div>\n  <div class=\"cast\">${g.characters.map(c=>{\n    const knownRole=c.publicRole||k.roles[c.id];\n    const knownFaction=k.factions[c.id];\n    const notKira=k.notKira.includes(c.id);\n    return `<div class=\"person ${c.isMe?'you':''}\"><div class=\"row between\"><div class=\"who\">${esc(c.displayName)}</div>${c.isLeader?tag('リーダー','green'):''}</div>\n      <div class=\"detail\">${c.isNPC?'NPC':c.isMe?'あなた':'プレイヤー'}</div>\n      <div class=\"known\">${knownRole?tag(ROLE[knownRole]||knownRole,c.publicRole?'green':'blue'):knownFaction?tag(knownFaction==='kira'?'キラ陣営':'L陣営','blue'):notKira?tag('キラではない','blue'):tag('役職不明')}\n      ${k.names.includes(c.id)?tag('本名判明','green'):tag('本名不明')}\n      ${k.noteChecks[c.id] ? tag(`R${k.noteChecks[c.id].round}:ノート${k.noteChecks[c.id].holding?'あり':'なし'}`,'blue'):''}</div></div>`;\n  }).join('')}</div><p class=\"notes\">表示される役職・本名の情報は、あなた自身が知っている範囲だけです。本名は「判明／不明」の状態として扱います。</p></div>`;\n}\nfunction privateScreen(g){\n  const messages=g.myKnowledge.messages;\n  return `<div class=\"panel\"><div class=\"title-sm\">あなたの秘密情報</div>\n  <div class=\"role-banner\"><div class=\"label\">あなたの役職</div><div class=\"title\">${esc(ROLE[g.myRole])}　${tag(g.myFaction==='kira'?'キラ陣営':'L陣営',g.myFaction==='kira'?'red':'blue')}</div>\n  ${g.notePersonal?`<div class=\"small\">現在のノート：<strong>${esc(g.notePersonal)}</strong></div>`:''}</div>\n  ${messages.length?messages.slice().reverse().map(m=>`<div class=\"message\"><span class=\"when\">R${m.round}</span>${esc(m.message)}</div>`).join(''):'<p class=\"muted small\">新しい情報はまだありません。</p>'}\n  </div>`;\n}\nfunction phaseHead(g){return `<div class=\"panel\"><div class=\"row between\"><div>${tag(`第${g.round} / 4 ラウンド`,'green')}<div class=\"title\" style=\"margin:9px 0 1px\">${esc(PHASE[g.phase]||g.phase)}</div></div>${g.deadline?`<div class=\"center\"><div class=\"label\">残り時間</div><div id=\"clock\" class=\"timer\">--:--</div></div>`:''}</div>\n   <div class=\"progress\">${[1,2,3,4].map(n=>`<span class=\"${n===g.round?'now':''}\">R${n}</span>`).join('')}</div>\n   <div class=\"row\">${tag(`任務成功 ${g.missionSuccessCount}/2`,'green')}${tag(g.isLeader?'あなたがリーダー':'相手がリーダー')}${g.revealedOnce?tag('NPC役職公開済み','blue'):''}</div>\n   ${g.lastPublicMission?`<div class=\"infobox ${g.lastPublicMission.success?'good':'warn'}\">第${g.lastPublicMission.round}ラウンドの任務結果：<strong>${g.lastPublicMission.success?'成功':'失敗'}</strong>（個別の選択は非公開）</div>`:''}\n   ${g.publicEvents.length?g.publicEvents.map(e=>`<div class=\"infobox good\">第${e.round}ラウンド：${esc(e.message)}</div>`).join(''):''}\n   ${snapshot.spectatorKey?`<div class=\"btnrow\">${btn('観戦URLをコピー','copy-watch','secondary')}</div>`:''}\n  </div>`;}\nfunction chooseTarget(g, field, label, filter=()=>true){\n  const options=g.characters.filter(filter);\n  const selected=draft[field]||'';\n  // Mobile-friendly buttons avoid native <select> being destroyed by delegated click rendering.\n  return `<div class=\"section-title\">${esc(label)}</div>\n   ${options.length?`<div class=\"grid\">${options.map(c=>pickCard(c.id,selected,personLabel(c,g),g.myKnowledge.roles[c.id]?ROLE[g.myKnowledge.roles[c.id]]:'',field)).join('')}</div>`\n   :'<p class=\"help\">現在選択できる対象はいません。</p>'}`;\n}\nfunction pickCard(value,selected,label,subtitle='',ui='ability'){\n return `<button type=\"button\" class=\"pick\" data-ui=\"${esc(ui)}\" data-value=\"${esc(value)}\" aria-pressed=\"${value===selected?'true':'false'}\"><span class=\"check\">${value===selected?'●':'○'}</span><span><span class=\"strong\">${esc(label)}</span>${subtitle?`<span class=\"npc\" style=\"display:block\">${esc(subtitle)}</span>`:''}</span></button>`;\n}\nfunction noteSetupScreen(g){\n  if(g.myRole!=='kira')return `<div class=\"panel\"><div class=\"title-sm\">初期ノート所持者を決定中</div><p class=\"muted\">もう1人のプレイヤーの準備を待っています。時間切れの場合は自動的に進みます。</p></div>`;\n  return `<div class=\"panel\">${heading('初期ノート所持者の決定','キラは最初にノートを持つ役職を指定できます。崇拝者の人物名はまだ分かりません。')}\n  <div class=\"grid\">${pickCard('kira',draft.holder,'キラ','自分で所持','holder')}${pickCard('devotee',draft.holder,'崇拝者','崇拝者に預ける','holder')}</div>\n  <div class=\"btnrow\"><button class=\"btn full\" data-action=\"note_choice\" ${!draft.holder?'disabled':''}>この所持者で確定</button></div>\n  <p class=\"help\">制限時間切れの場合はキラが所持します。</p></div>`;\n}\nfunction missionHistoryPanel(g){\n  const history=g.missionHistory||[];\n  return `<div class=\"panel\"><div class=\"row between\"><div class=\"title-sm\">これまでの任務履歴</div>${tag(`成功 ${g.missionSuccessCount}/2`,'green')}</div>\n    ${history.length?history.map(m=>`<div class=\"subpanel\"><div class=\"row between\"><strong>第${m.round}ラウンド</strong>${tag(m.success?'成功':'失敗',m.success?'green':'red')}</div>\n    <div class=\"small muted\" style=\"margin-top:6px\">参加者：${m.memberIds.map(id=>esc(g.characters.find(c=>c.id===id)?.displayName||'不明')).join(' ＋ ')}</div></div>`).join(''):'<p class=\"muted small\">まだ任務結果は発表されていません。</p>'}\n    <p class=\"help\">公開された結果だけを表示。誰が「成功／失敗」を選んだかは分かりません。</p>\n  </div>`;\n}\nfunction discussionScreen(g){\n  return `<div class=\"panel\">${heading('議論フェーズ','Discordなどの音声通話で、正体と行動について話し合ってください。')}\n   <div class=\"infobox\">${g.round===4?'最終ラウンドです。この後は夜の能力使用のみ行います。':g.missionSuccessCount>=2?'任務成功が2回に達したため、以降の任務はありません。':'議論後、リーダーが2人の任務参加者を選出します。'}</div>\n   ${g.isLeader?`<p class=\"help\">あなたがリーダーです。時間切れを待たずに議論を終了できます。</p>${btn('議論を終了して次へ進む','end_discussion','full')}`:'<p class=\"muted\">リーダーが議論を終了するか、タイマーが切れると自動で次へ進みます。</p>'}\n  </div>${missionHistoryPanel(g)}`;\n}\nfunction selectionScreen(g){\n  if(!g.isLeader)return `<div class=\"panel\">${heading('任務参加者を選出中','リーダーが2人を選んでいます。')}<p class=\"muted\">任務参加者には、必ずNPCが1人以上含まれます。</p></div>`;\n  const selected=draft.missionIds||[];\n  return `<div class=\"panel\">${heading('任務参加者を2人選ぶ','2人のうち最低1人はNPCである必要があります。')}\n   <div class=\"row between\"><span class=\"label\">参加者候補</span>${tag(`${selected.length} / 2 選択`,'green')}</div><div class=\"grid\">\n    ${g.characters.map(c=>{\n      const checked=selected.includes(c.id);\n      const selectedHuman=selected.some(id=>!g.characters.find(p=>p.id===id).isNPC);\n      const disabled=!checked && (selected.length>=2 || (!c.isNPC && selectedHuman));\n      return `<button type=\"button\" class=\"pick\" data-ui=\"mission\" data-value=\"${esc(c.id)}\" aria-pressed=\"${checked?'true':'false'}\" ${disabled?'disabled':''}><span class=\"check\">${checked?'●':'○'}</span><span class=\"grow\"><span class=\"strong\">${esc(personLabel(c,g))}</span><span class=\"npc\" style=\"display:block\">${c.isNPC?'NPC':'プレイヤー'}</span></span></button>`;\n    }).join('')}</div>\n    <div class=\"btnrow\"><button class=\"btn full\" data-action=\"mission_select\" ${selected.length!==2?'disabled':''}>この2人で任務を実施</button></div>\n    <p class=\"help\">時間切れの場合は有効な組み合わせから自動選出します。</p></div>`;\n}\nfunction revealScreen(g){\n  if(!g.isLeader)return `<div class=\"panel\">${heading('NPC役職公開','リーダーが公開対象を選んでいます。')}<p class=\"muted\">任務を2回成功させたため、NPCの役職が1人分公開されます。</p></div>`;\n  return `<div class=\"panel\">${heading('公開するNPCを1人選ぶ','選んだNPCの正確な役職が全員に公開されます。このイベントは1ゲームに1回です。')}\n     <div class=\"grid\">${g.characters.filter(c=>c.isNPC).map(c=>pickCard(c.id,draft.target,c.displayName,'NPC','reveal')).join('')}</div>\n     <div class=\"btnrow\"><button class=\"btn full\" data-action=\"reveal\" ${!draft.target?'disabled':''}>このNPCの役職を公開</button></div>\n     <p class=\"help\">時間切れの場合はNPCがランダムに選択されます。</p></div>`;\n}\nfunction abilityTargets(g){\n  const a=draft.ability;\n  switch(a){\n    case 'judge': return chooseTarget(g,'target','裁く人物（本名を知っている人のみ）',c=>g.myKnowledge.names.includes(c.id)&&!c.isMe);\n    case 'investigate': return chooseTarget(g,'target','陣営を調査する人物');\n    case 'search': return chooseTarget(g,'target','ノート所持を捜査するNPC',c=>c.isNPC);\n    case 'infer': return chooseTarget(g,'target','キラだと思う人物',c=>!c.isMe)+chooseTarget(g,'target2','崇拝者だと思う人物',c=>!c.isMe&&c.id!==draft.target);\n    case 'raid': return chooseTarget(g,'target','現在のノート所持者',c=>!c.isMe)+chooseTarget(g,'target2','もう1人の捜査員',c=>!c.isMe&&c.id!==draft.target);\n    default:return '';\n  }\n}\nfunction actionValid(g){\n  const a=draft.ability;\n  if(g.missionMembers.includes(g.myId)&&!['success','failure'].includes(draft.missionVote))return false;\n  if(!g.availableActions.includes(a))return false;\n  if(['judge','investigate','search'].includes(a))return !!draft.target;\n  if(['infer','raid'].includes(a))return !!(draft.target&&draft.target2&&draft.target!==draft.target2);\n  return true;\n}\nfunction nightEndControl(g){\n  return `<div class=\"subpanel\"><div class=\"title-sm\">夜を手動で終了</div><p class=\"help\">両プレイヤーが同意すると終了します。未確定の能力は「何もしない」、任務は「失敗」扱いになります。</p><div class=\"small muted\">終了同意：${g.nightEndCount}/2</div>${g.myNightEndRequested?'<p class=\"success strong\">同意済み。相手を待っています。</p>':btn('夜の終了に同意する','request_night_end','secondary full')}</div>`;\n}\nfunction nightScreen(g){\n  if(g.myActionSubmitted)return `<div class=\"panel\">${heading('今夜の行動を確定しました','取得した情報は下の「あなたの秘密情報」に表示されています。')}\n    <div class=\"infobox good\">自分の操作は完了です。${g.otherActionSubmitted?'両者の行動を処理しています。':'相手の確定または時間切れを待っています。'}</div>${nightEndControl(g)}</div>`;\n  const missionMember=g.missionMembers.includes(g.myId);\n  return `<div class=\"panel\">${heading('夜の行動','任務に参加している場合は成否を選び、特殊能力を1つ使用できます。')}\n     ${g.missionMembers.length?`<div class=\"infobox\">任務参加者：${g.missionMembers.map(id=>esc(g.characters.find(c=>c.id===id).displayName)).join(' ＋ ')}<br><span class=\"muted\">個別の選択は公開されません。</span></div>`:'<div class=\"infobox\">このラウンドは任務を行いません。</div>'}\n     ${missionMember?`<div class=\"section-title\">任務の選択</div><div class=\"grid\">${pickCard('success',draft.missionVote,'成功','任務を成功させたい','vote')}${pickCard('failure',draft.missionVote,'失敗','任務を失敗させたい','vote')}</div>`:''}\n     <div class=\"section-title\">特殊能力（1つ選択）</div><div class=\"grid\">${g.availableActions.map(a=>pickCard(a,draft.ability,ABILITY[a],'', 'ability')).join('')}</div>\n     <div class=\"subpanel\"><p class=\"small\">${esc(ABILITY_DESC[draft.ability]||'')}</p>${abilityTargets(g)}</div>\n     <div class=\"btnrow\"><button class=\"btn full\" data-action=\"night_action\" ${actionValid(g)?'':'disabled'}>夜の行動を確定する</button></div>\n     <p class=\"help\">能力の選択は1回限りで、確定後は変更できません。時間切れで未提出の場合は能力を使わず、任務も失敗側に処理されます。</p>\n     ${nightEndControl(g)}\n   </div>`;\n}\nfunction nightReviewScreen(g){\n  return `<div class=\"panel\">${heading('夜の情報確認','この夜に得た情報は下の「あなたの秘密情報」に届いています。')}\n   <div class=\"infobox\">全員の確認が終わるか、タイマーが切れると次の昼になります。<br>任務結果は次の昼に発表されます。</div>\n   ${g.reviewReady?'<p class=\"success strong\">確認済み。もう1人を待っています。</p>':btn('情報を確認して次へ','night_review_ready','full')}\n  </div>`;\n}\nfunction finishedScreen(g){\n  const labels={kira:'キラ陣営の勝利',l:'L陣営の勝利',draw:'引き分け'};\n  const won=g.winner===g.myFaction;\n  return `<div class=\"panel\"><div class=\"winner ${g.winner==='draw'?'draw':''}\">${esc(labels[g.winner]||'ゲーム終了')}</div>\n  <div class=\"center muted small\">${won?'あなたの陣営が勝ちました！':g.winner==='draw'?'両陣営の勝利条件が同時成立しました。':'最終結果が確定しました。'}</div>\n  <div class=\"infobox\">${esc(g.reason)}</div>\n  <div class=\"section-title\">全員の役職</div>${g.characters.map(c=>`<div class=\"subpanel row between\"><strong>${esc(personLabel(c,g))}</strong>${tag(ROLE[c.finalRole],['kira','devotee'].includes(c.finalRole)?'red':'blue')}</div>`).join('')}\n  <div class=\"section-title\">任務の履歴</div>${g.missionHistory.length?g.missionHistory.map(m=>`<div class=\"subpanel row between\"><span>第${m.round}ラウンド　${m.memberIds.map(id=>esc(g.characters.find(c=>c.id===id).displayName)).join('・')}</span>${tag(m.success?'成功':'失敗',m.success?'green':'red')}</div>`).join(''):'<p class=\"muted small\">任務の履歴はありません。</p>'}\n  <div class=\"info-row\"><span>最終所持者</span><span>${esc(g.characters.find(c=>c.id===g.finalNoteHolderId)?.displayName||'不明')}</span></div>\n  <div class=\"btnrow\">${btn('新しいゲームへ','leave','full secondary')}</div>\n  <p class=\"help\">再戦する場合は新しいルームを作成してください。</p></div>`;\n}\nfunction spectatorScreen(s){\n  const g=s.game;\n  if(!g)return `<div class=\"panel\"><h2 class=\"title\">観戦待機中</h2><p class=\"muted\">2人のプレイヤーがゲームを開始すると、自動で観戦画面が更新されます。</p></div>`;\n  const names=Object.fromEntries(g.characters.map(c=>[c.id,c.displayName]));\n  const cast=g.characters.map(c=>`<div class=\"person\"><div class=\"who\">${esc(c.displayName)}</div><div class=\"known\">${tag(ROLE[c.role],c.faction==='kira'?'red':'blue')}${tag(c.isNPC?'NPC':'プレイヤー')}${c.isLeader?tag('リーダー','green'):''}</div></div>`).join('');\n  return `<div class=\"panel\"><div class=\"row between\"><div>${tag(`第${g.round} / 4 ラウンド`,'green')}<h2 class=\"title\">${esc(PHASE[g.phase]||g.phase)}</h2></div>${g.deadline?'<div class=\"center\"><div class=\"label\">残り時間</div><div id=\"clock\" class=\"timer\">--:--</div></div>':''}</div>\n  <p class=\"help\">観戦専用：全員の役職を表示しています。ゲームの操作はできません。</p>\n  ${g.winner?`<div class=\"infobox good\"><strong>${g.winner==='draw'?'引き分け':g.winner==='kira'?'キラ陣営の勝利':'L陣営の勝利'}</strong>：${esc(g.reason||'')}</div>`:''}</div>\n  <div class=\"panel\"><div class=\"title-sm\">全員の役職（観戦者のみ公開）</div><div class=\"cast\">${cast}</div></div>\n  <div class=\"panel\"><div class=\"title-sm\">進行状況</div><div class=\"info-row\"><span>ノート所持者</span><span>${esc(names[g.noteHolderId]||'未決定')}</span></div>\n    <div class=\"info-row\"><span>任務成功</span><span>${g.missionSuccessCount}/2</span></div>\n    <div class=\"info-row\"><span>今回の任務</span><span>${g.missionMembers.length?g.missionMembers.map(id=>esc(names[id])).join(' ＋ '):'なし'}</span></div>\n    <p class=\"help\">現在ラウンドの任務結果と各自の秘密の選択は公開しません。</p></div>\n  <div class=\"panel\"><div class=\"title-sm\">公開済みの任務履歴</div>${g.missionHistory.length?g.missionHistory.map(m=>`<div class=\"subpanel\">第${m.round}ラウンド　${m.memberIds.map(id=>esc(names[id])).join(' ＋ ')}　${tag(m.success?'成功':'失敗',m.success?'green':'red')}</div>`).join(''):'<p class=\"muted small\">まだありません。</p>'}</div>\n  ${g.publicEvents.length?`<div class=\"panel\"><div class=\"title-sm\">公開イベント</div>${g.publicEvents.map(e=>`<p class=\"small\">${esc(e.message)}</p>`).join('')}</div>`:''}`;\n}\nfunction render(){\n  if(session?.isSpectator){app.innerHTML=snapshot?spectatorScreen(snapshot):'<div class=\"panel\">観戦に接続中…</div>';updateClock();return;}\n  if(!session){app.innerHTML=homeScreen();return;}\n  if(!snapshot){app.innerHTML='<div class=\"panel center\">ルームに接続しています…</div>';return;}\n  if(snapshot.status==='lobby'){app.innerHTML=lobbyScreen();return;}\n  const g=snapshot.game;\n  if(!g){app.innerHTML='<div class=\"panel\">ゲームを読み込んでいます…</div>';return;}\n  let main='';\n  if(g.phase==='note_setup')main=noteSetupScreen(g);\n  if(g.phase==='role_reveal')main=revealScreen(g);\n  if(g.phase==='discussion')main=discussionScreen(g);\n  if(g.phase==='mission_selection')main=selectionScreen(g);\n  if(g.phase==='night')main=nightScreen(g);\n  if(g.phase==='night_review')main=nightReviewScreen(g);\n  if(g.phase==='finished')main=finishedScreen(g);\n  const phase=g.phase==='finished'?'':phaseHead(g);\n  app.innerHTML=phase+`<div class=\"two-col\"><div>${main}${g.phase==='finished'?'':castScreen(g)}</div><div>${privateScreen(g)}<div class=\"panel\"><details class=\"notes\"><summary>ルールの要点</summary><p>プレイヤー2人＋NPC3人。任務にはNPCを最低1人含める。任務成功2回で次の昼にNPCの役職を1人公開し、以後の任務は終了。4ラウンド目は任務なし。第3ラウンドから裁き・推理・突入が使えます。両陣営が同じ夜に勝利条件を満たすと引き分け。</p><p>議論はリーダーが手動終了可能。時間切れは自動処理します。夜の取得情報はその場で自分だけに表示します。</p></details></div></div></div>`;\n  updateClock();\n}\nasync function send(type,data={}){\n  if(!session||busy)return;\n  busy=true;showError('');\n  try{await api(`/api/rooms/${session.code}/action`,{token:session.token,type,data});}\n  catch(e){showError(e.message);}finally{busy=false;}\n}\napp.addEventListener('submit',async(e)=>{\n  e.preventDefault();if(busy)return;busy=true;showError('');\n  const f=e.target;\n  try{\n    if(f.id==='createForm'){\n      const data=await api('/api/rooms',{name:f.elements.name.value,discussionSeconds:Number(f.elements.discussionSeconds.value),nightSeconds:Number(f.elements.nightSeconds.value)});\n      remember(data);history.replaceState(null,'',roomUrl(data.code));connect();\n    }else if(f.id==='joinForm'){\n      const code=f.elements.code.value.trim().toUpperCase();\n      if(!/^[A-Z2-9]{6}$/.test(code))throw new Error('6桁のルームコードを入力してください');\n      const data=await api(`/api/rooms/${code}/join`,{name:f.elements.name.value});\n      remember(data);history.replaceState(null,'',roomUrl(code));connect();\n    }\n  }catch(err){showError(err.message);}finally{busy=false;}\n});\napp.addEventListener('change',e=>{\n  const input=e.target;\n  if(input.dataset.ui==='target'){\n    draft[input.dataset.field]=input.value;\n    // When target 1 changes, second target must be reselected.\n    if(input.dataset.field==='target')draft.target2='';\n    render();\n  }\n});\napp.addEventListener('click',async e=>{\n  const el=e.target.closest('[data-ui], [data-action]');\n  if(!el)return;\n  if(el.dataset.ui){\n    if(el.tagName==='SELECT'||el.tagName==='INPUT')return;\n    const mode=el.dataset.ui,val=el.dataset.value;\n    if(mode==='mission'){\n      const selected=draft.missionIds||[];\n      draft.missionIds=selected.includes(val)?selected.filter(id=>id!==val):[...selected,val];\n    } else if(mode==='ability'){\n      draft.ability=val;draft.target='';draft.target2='';\n    } else if(mode==='target'||mode==='target2'){\n      draft[mode] = draft[mode]===val ? '' : val;\n      if(mode==='target')draft.target2='';\n    } else if(mode==='vote')draft.missionVote=val;\n    else if(mode==='holder')draft.holder=val;\n    else if(mode==='reveal')draft.target=val;\n    render();return;\n  }\n  const action=el.dataset.action;\n  if(!action)return;\n  if(action==='copy-watch'){\n    const key=snapshot?.spectatorKey;\n    if(!key)return showError('観戦URLはホストだけが取得できます');\n    const url=spectatorUrl(session.code,key);\n    try{await navigator.clipboard.writeText(url);showError('観戦URLをコピーしました。役職が全公開されるのでプレイヤーには送らないでください。');}\n    catch{window.prompt('観戦専用URL（プレイヤーには送らないでください）',url);}\n    return;\n  }\n  if(action==='copy-url'){\n    try{await navigator.clipboard.writeText(roomUrl(session.code));showError('');el.textContent='コピーしました！';}\n    catch{window.prompt('このURLを共有してください',roomUrl(session.code));}\n    return;\n  }\n  if(action==='leave'){\n    if(confirm('このルームを離れて新しいゲームを始めますか？')){history.replaceState(null,'',location.pathname);resetSession();}\n    return;\n  }\n  if(action==='start'){\n    if(busy)return;busy=true;\n    try{await api(`/api/rooms/${session.code}/start`,{token:session.token});}catch(e){showError(e.message);}finally{busy=false;}\n    return;\n  }\n  if(action==='end_discussion'){\n    if(!confirm('議論を終了して次のフェーズへ進みますか？'))return;\n  }\n  if(action==='night_action' && !confirm('この夜の行動を確定しますか？確定後は変更できません。'))return;\n  if(action==='request_night_end' && !confirm('夜の終了に同意しますか？ 両者が同意すると未提出の行動は「何もしない」として終了します。'))return;\n  if(action==='mission_select' && !confirm('選出した2人で任務を開始しますか？'))return;\n  const d={};\n  if(action==='note_choice')d.holder=draft.holder;\n  if(action==='reveal')d.target=draft.target;\n  if(action==='mission_select')d.members=draft.missionIds;\n  if(action==='night_action'){\n    d.ability=draft.ability;d.target=draft.target||null;d.target2=draft.target2||null;\n    if(snapshot.game.missionMembers.includes(snapshot.game.myId))d.missionVote=draft.missionVote;\n  }\n  await send(action,d);\n});\ninit();\n","index.html":"<!doctype html>\n<html lang=\"ja\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n  <meta name=\"theme-color\" content=\"#10151c\">\n  <meta name=\"description\" content=\"2人で遊べるオンライン正体隠蔽ゲーム\">\n  <title>スーパーキラゲーム — 正体隠蔽ゲーム</title>\n  <link rel=\"stylesheet\" href=\"/styles.css\">\n  <script src=\"/client.js\" defer></script>\n</head>\n<body>\n  <main class=\"wrap\">\n    <header class=\"brand\"><span class=\"brand-mark\">◈</span><div><div class=\"brand-title\">スーパー<span>キラゲーム</span></div><div class=\"brand-sub\">TWO-PLAYER HIDDEN IDENTITY GAME</div></div></header>\n    <div class=\"topline\"><span id=\"netStatus\">オフライン</span><span id=\"roomTag\"></span></div>\n    <div id=\"toast\" role=\"alert\" aria-live=\"polite\"></div>\n    <div id=\"app\"><div class=\"panel\">読み込み中…</div></div>\n    <footer>2人専用 / 音声で議論しながらプレイ / ゲームマスター不要 / v1.2</footer>\n  </main>\n</body>\n</html>\n","styles.css":":root{color-scheme:dark;--bg:#10151c;--panel:#1a222d;--panel2:#222d3b;--line:#344154;--text:#e8eef6;--muted:#a3b0c1;--accent:#cae084;--red:#ff8d94;--blue:#91c5e8;--r:14px;--shadow:0 12px 35px #0002}\n*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse 105% 370px at 50% 0,#223045 0,transparent 80%),var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,\"Hiragino Kaku Gothic ProN\",\"Noto Sans JP\",Meiryo,sans-serif;line-height:1.6;font-size:15px}\n.wrap{max-width:940px;margin:auto;padding:22px 16px 38px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:16px}.brand-mark{font-size:35px;color:var(--accent)}.brand-title{font-size:22px;font-weight:900;letter-spacing:2px;line-height:1.05}.brand-title span{color:var(--accent)}.brand-sub{color:var(--muted);font-size:9px;letter-spacing:2.3px;margin-top:7px}.topline{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:12px;border-block:1px solid var(--line);padding:8px 2px;margin-bottom:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:19px;margin-bottom:15px;box-shadow:var(--shadow)}.subpanel{padding:12px;border:1px solid var(--line);background:var(--panel2);border-radius:10px;margin-top:10px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.between{justify-content:space-between}.grow{flex:1}.mini{font-size:12px;color:var(--muted)}.small{font-size:13px}.muted{color:var(--muted)}.center{text-align:center}.strong{font-weight:750}.title{font-size:21px;line-height:1.4;margin:0 0 9px}.title-sm{font-size:17px;font-weight:800;margin:0 0 9px}.section-title{font-size:13px;color:var(--accent);font-weight:800;letter-spacing:.06em;margin:20px 0 8px}.top-section{margin-top:0}.tag{background:#273646;border:1px solid #405269;border-radius:7px;padding:2px 7px;font-size:11px;white-space:nowrap}.tag.green{color:var(--accent);border-color:#566c40}.tag.red{color:var(--red);border-color:#885158}.tag.blue{color:var(--blue);border-color:#476783}.timer{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--accent)}.timer.danger{color:var(--red)}.btn{appearance:none;border:1px solid #607349;background:#c4dc85;color:#172315;border-radius:11px;padding:12px 15px;line-height:1.4;font:inherit;font-size:14px;font-weight:800;min-height:45px;cursor:pointer;transition:filter .12s}.btn:hover:not(:disabled){filter:brightness(1.07)}.btn:active:not(:disabled){filter:brightness(.95)}.btn:disabled{opacity:.4;cursor:not-allowed}.btn.secondary{color:var(--text);border-color:#65778a;background:#354558}.btn.danger{background:#593c44;border-color:#ae6d7a;color:#ffe7e7}.btn.full{width:100%}.btn.slim{min-height:38px;padding:8px 11px}.btnrow{display:flex;flex-wrap:wrap;gap:9px;margin-top:12px}.btnrow>*{flex:1}.input{width:100%;min-height:43px;padding:10px 13px;border:1px solid #57677b;border-radius:10px;background:#101922;color:var(--text);font:inherit;margin:7px 0 10px}.input:focus,.pick:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.label{color:var(--muted);font-size:12px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}.pick{border:1px solid #4b5c70;background:#263343;color:var(--text);padding:11px;border-radius:10px;min-height:62px;cursor:pointer;text-align:left;font:inherit;display:flex;align-items:center;gap:9px}.pick[aria-pressed=true]{border:2px solid var(--accent);background:#34452c;padding:10px}.pick:disabled{cursor:not-allowed;opacity:.43}.pick .check{color:var(--accent);font-size:16px}.pick .npc{font-size:11px;color:var(--muted)}.pill{border-radius:20px;padding:2px 8px;background:#354657;font-size:11px;white-space:nowrap}.cast{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.person{border:1px solid var(--line);border-radius:11px;padding:10px 11px;background:#192533;min-width:0}.person.you{border-color:#6b8153}.person .who{font-weight:800;word-break:break-word}.person .detail{color:var(--muted);font-size:11px;margin-top:3px}.person .known{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}.infobox{padding:11px 13px;border-left:3px solid var(--blue);background:#253447;border-radius:5px;margin:9px 0;font-size:13px}.infobox.good{border-color:var(--accent)}.infobox.warn{border-color:var(--red)}.message{border-bottom:1px solid var(--line);padding:9px 0;font-size:13px}.message:last-child{border:0}.message .when{color:var(--muted);font-size:11px;margin-right:8px}.progress{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:12px 0}.progress span{border-radius:6px;background:#344254;text-align:center;font-size:12px;padding:5px;color:var(--muted)}.progress span.now{background:#667b4d;color:#fff;font-weight:800}.divider{border:0;border-top:1px solid var(--line);margin:17px 0}.info-row{display:grid;grid-template-columns:115px 1fr;gap:6px;font-size:13px;margin:5px 0}.info-row span:first-child{color:var(--muted)}.success{color:var(--accent)}.fail{color:var(--red)}.notes{font-size:12px;color:var(--muted);line-height:1.8}.notes summary{cursor:pointer;color:var(--blue);font-weight:700}#toast:empty{display:none}#toast{border:1px solid #b76672;background:#583842;color:#ffe5e7;padding:11px;border-radius:10px;margin-bottom:12px;font-size:13px}footer{text-align:center;color:#778598;font-size:11px;padding-top:12px}.hero{padding:24px 12px;text-align:center}.hero .title{font-size:28px;letter-spacing:.025em}.role-banner{border-left:4px solid var(--accent);background:#263443;padding:15px;border-radius:7px;margin:12px 0}.winner{font-size:26px;font-weight:900;text-align:center;color:var(--accent);padding:15px 0}.winner.draw{color:#d4c4eb}.help{color:var(--muted);font-size:12px;margin:5px 0 10px}.counter{display:inline-block;font-variant-numeric:tabular-nums;color:var(--accent)}.fixedbtns{display:flex;gap:8px;flex-wrap:wrap}.fixedbtns .btn{flex:1}#netStatus.online{color:var(--accent)}\n@media(min-width:720px){.two-col{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:16px;align-items:start}.cast{grid-template-columns:repeat(3,minmax(0,1fr))}.wrap{padding-top:32px}}\n@media(max-width:400px){.grid.three{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:14px}.person{padding:9px}.brand-title{font-size:20px}.info-row{grid-template-columns:95px 1fr}}\n\n/* Mobile spectator cards and revised title */\n.brand-title{letter-spacing:.015em;line-height:1.3}.brand-sub{letter-spacing:.10em}\n@media(max-width:400px){.brand-title{font-size:19px}}\n"}));
const assets = new Map([['/', ['index.html','text/html; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']],['/client.js',['client.js','application/javascript; charset=utf-8']]]);

function json(res,status,data) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
}
function error(res, status, message) { json(res,status,{error:message}); }
function makeRoomCode() {
  for (let attempts=0; attempts<100; attempts++) {
    let code='';for(let i=0;i<6;i++)code+=CHARSET[randomInt(CHARSET.length)];
    if(!rooms.has(code))return code;
  }
  throw Error('ルームコードを作れませんでした');
}
function cleanName(input) {
  if (typeof input !== 'string') throw Object.assign(Error('ハンドルネームを入力してください'),{status:400});
  const name=input.trim().replace(/\s+/g,' ');
  if (Array.from(name).length<1 || Array.from(name).length>16 || /[\u0000-\u001f\u007f]/.test(name)) throw Object.assign(Error('ハンドルネームは1〜16文字で入力してください'),{status:400});
  return name;
}
function newPerson(name, host=false) {return {id:randomBytes(10).toString('hex'),token:randomBytes(32).toString('hex'),name,host};}
function validRoom(code){const room=rooms.get(code);if(!room) throw Object.assign(Error('ルームが見つかりません'),{status:404});return room;}
function auth(room,token){
  const player=room.players.find(p=>p.token===token);
  if(!player)throw Object.assign(Error('参加情報が無効です。ルームに参加し直してください'),{status:403});
  return player;
}
function roomView(room,player) {
  if (player.spectator) {
    return {code:room.code, status:room.status, isSpectator:true, spectatorCount:room.spectators.length,
      players:room.players.map(p=>({id:p.id,name:p.name})),game:room.game?spectatorView(room.game):null};
  }
  return {
    code: room.code,
    status: room.status,
    settings: {...room.settings},
    spectatorCount: room.spectators.length,
    spectatorKey: player.host ? room.spectatorKey : undefined,
    selfId:player.id,
    isHost:player.host,
    players:room.players.map(p=>({id:p.id,name:p.name,connected:(room.listeners.get(p.id)?.size||0)>0})),
    game:room.game ? viewFor(room.game,player.id) : null
  };
}
function broadcast(room){
  room.updatedAt=Date.now();
  for(const p of [...room.players,...room.spectators]){
    const data=`event: snapshot\ndata: ${JSON.stringify(roomView(room,p))}\n\n`;
    for(const res of room.listeners.get(p.id) || []){
      try{res.write(data);}catch{room.listeners.get(p.id)?.delete(res);}
    }
  }
}
async function readBody(req){
  let body='';
  for await(const chunk of req){
    body+=chunk.toString();
    if(body.length>16000)throw Object.assign(Error('リクエストが大きすぎます'),{status:413});
  }
  try{return body?JSON.parse(body):{};}catch{throw Object.assign(Error('JSON形式が正しくありません'),{status:400});}
}
function configureSecurity(res){
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'");
}
async function handler(req,res){
  configureSecurity(res);
  const url=new URL(req.url,`http://${req.headers.host || 'localhost'}`);
  const path=url.pathname;
  try{
    if(req.method==='GET' && path==='/health')return json(res,200,{status:'ok',rooms:rooms.size});
    if(req.method==='GET' && assets.has(path)){
      const [name, mime]=assets.get(path);
      const file = embeddedAssets.get(name);
      res.writeHead(200,{'content-type':mime,'cache-control':'no-cache'});res.end(file);return;
    }
    if(req.method==='POST' && path==='/api/rooms'){
      const data=await readBody(req);
      const p=newPerson(cleanName(data.name),true);
      const code=makeRoomCode();
      const settings=parseSettings(data);
      rooms.set(code,{code,players:[p],spectators:[],spectatorKey:randomBytes(32).toString('hex'),settings,game:null,status:'lobby',listeners:new Map(),createdAt:Date.now(),updatedAt:Date.now()});
      return json(res,201,{code,token:p.token,playerId:p.id});
    }
    const m=path.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|spectate|start|action|state|events))?$/);
    if(!m)return error(res,404,'ページが見つかりません');
    const [,code,endpoint]=m;
    const room=validRoom(code);
    if(req.method==='POST' && endpoint==='join'){
      const data=await readBody(req);
      if(room.status!=='lobby')return error(res,409,'すでにゲームが始まっています');
      if(room.players.length>=2)return error(res,409,'このルームは満員です');
      const name=cleanName(data.name);
      if(room.players.some(p=>p.name===name))return error(res,409,'同じハンドルネームは使用できません');
      const p=newPerson(name);
      room.players.push(p);
      broadcast(room);
      return json(res,201,{code,token:p.token,playerId:p.id});
    }
    if(req.method==='POST' && endpoint==='spectate'){
      const data=await readBody(req);
      if(typeof data.key !== 'string' || data.key !== room.spectatorKey) return error(res,403,'観戦URLが正しくありません');
      const previous=room.spectators.find(p=>p.token===data.token);
      if(previous)return json(res,200,{code,token:previous.token,isSpectator:true});
      if(room.spectators.length>=20)return error(res,409,'観戦者の上限に達しています');
      const watcher={id:randomBytes(10).toString('hex'),token:randomBytes(32).toString('hex'),spectator:true};
      room.spectators.push(watcher);
      broadcast(room);
      return json(res,201,{code,token:watcher.token,isSpectator:true});
    }
    if(req.method==='GET' && endpoint==='events'){
      const token=url.searchParams.get('token');
      const player=room.spectators.find(p=>p.token===token) || auth(room,token);
      // EventSource reconnects automatically; the token is a 256-bit unguessable session credential.
      res.writeHead(200,{
        'content-type':'text/event-stream; charset=utf-8',
        'cache-control':'no-cache, no-transform',
        'connection':'keep-alive','x-accel-buffering':'no'
      });
      res.write(`retry: 1800\n\nevent: snapshot\ndata: ${JSON.stringify(roomView(room,player))}\n\n`);
      if(!room.listeners.has(player.id))room.listeners.set(player.id,new Set());
      room.listeners.get(player.id).add(res);
      broadcast(room);
      req.on('close',()=>{
        room.listeners.get(player.id)?.delete(res);
        broadcast(room);
      });
      return;
    }
    if(req.method==='GET' && endpoint==='state'){
      const token=url.searchParams.get('token');
      const player=room.spectators.find(p=>p.token===token) || auth(room,token);
      return json(res,200,roomView(room,player));
    }
    if(req.method==='POST' && (endpoint==='start'||endpoint==='action')){
      const data=await readBody(req);
      const player=auth(room,data.token);
      if(endpoint==='start'){
        if(!player.host) return error(res,403,'ホストのみ開始できます');
        if(room.players.length!==2) return error(res,409,'2人参加してから開始してください');
        if(room.status!=='lobby') return error(res,409,'すでに開始されています');
        room.game=newGame(room.players,Date.now(),randomInt,room.settings);
        room.status='active';
        validateEngine(room.game);
        broadcast(room);
        return json(res,200,{ok:true});
      }
      if(room.status!=='active'||!room.game)return error(res,409,'ゲーム進行中ではありません');
      performAction(room.game,player.id,data.type,data.data ?? {});
      validateEngine(room.game);
      if(room.game.phase==='finished')room.status='finished';
      broadcast(room);
      return json(res,200,{ok:true});
    }
    error(res,405,'利用できない操作です');
  } catch(e){
    if(!res.headersSent)error(res,e.status||400,e.message||'サーバーエラー');
    else res.end();
  }
}

const server=http.createServer(handler);
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(room.status==='active' && room.game && tick(room.game,now)){
      if(room.game.phase==='finished')room.status='finished';
      broadcast(room);
    }
    if((room.status==='finished' && now-room.updatedAt>6*60*60*1000) ||
       (room.status==='lobby' && now-room.createdAt>12*60*60*1000)){
      for(const listeners of room.listeners.values())for(const res of listeners)res.end();
      rooms.delete(code);
    }
  }
},500).unref();
setInterval(()=>{
  for(const room of rooms.values())for(const listeners of room.listeners.values())for(const res of listeners){
    try{res.write(': ping\n\n');}catch{}
  }
},20000).unref();
server.listen(PORT,HOST,()=>console.log(`Super Kira Game listening on http://${HOST}:${PORT}`));
