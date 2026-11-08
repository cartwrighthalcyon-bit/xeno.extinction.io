// XENO.IO chat filter: shared by the server (authoritative) and the game page (preview).
// Blocks profanity (including disguised spellings), social media names, handles, links, emails,
// phone numbers and internet slang. Blocked words are replaced with asterisks.
(function (root) {
  const PROFANE_ROOTS = ['fuck', 'fuk', 'fck', 'shit', 'sht', 'bitch', 'btch', 'cunt', 'nigg', 'nigga', 'fagg', 'faggot', 'whore', 'slut', 'bastard', 'asshole', 'dickhead', 'motherf', 'retard', 'pussy', 'penis', 'vagina', 'porn', 'cock', 'wank', 'twat', 'bollock', 'prick', 'damn', 'goddamn', 'kys', 'killyourself', 'rape', 'nazi', 'hitler', 'chink', 'spic', 'kike', 'tranny', 'dyke', 'jizz', 'cum', 'boob', 'tits', 'nude', 'sex', 'horny', 'piss', 'crap', 'douche', 'hoe'];
  const PROFANE_EXACT = ['ass', 'arse', 'dick', 'dck', 'hell', 'fag', 'nig', 'tit', 'cum', 'hoe', 'hoes', 'stfu', 'gtfo', 'wtf', 'wth', 'fu', 'fk', 'af', 'pos', 'mf', 'mfer', 'smd'];
  const SAFE = ['class', 'pass', 'grass', 'glass', 'mass', 'bass', 'assist', 'assassin', 'hello', 'shell', 'shellfish', 'hellhound', 'cocktail', 'peacock', 'scrap', 'scrape', 'skill', 'spicy', 'title', 'dickens', 'shoe', 'hoed', 'cucumber', 'document', 'circumstance', 'essex', 'sussex', 'pisces', 'grape', 'drape', 'therapist', 'nigeria', 'snigger', 'cockroach', 'hancock', 'scunthorpe', 'analysis', 'matsex', 'bassist', 'compass', 'bypass', 'mishell'];
  const SOCIAL = ['instagram', 'insta', 'ig', 'tiktok', 'tiktoc', 'tt', 'snapchat', 'snap', 'sc', 'discord', 'dc', 'disc', 'twitter', 'tweet', 'facebook', 'fb', 'messenger', 'youtube', 'yt', 'twitch', 'ttv', 'reddit', 'telegram', 'tg', 'whatsapp', 'kik', 'onlyfans', 'skype', 'wechat', 'threads', 'bluesky', 'bsky', 'mastodon', 'pinterest', 'linkedin', 'tumblr', 'venmo', 'cashapp', 'paypal', 'xbox', 'psn', 'gmail', 'hotmail', 'yahoo', 'outlook', 'email', 'dm', 'dms', 'subscribe', 'sub2', 'subz', 'sub4sub', 'follow me on', 'add me on', 'add me', 'hit me up', 'my insta', 'my snap', 'my discord'];
  const SLANG = ['lol', 'lmao', 'lmfao', 'rofl', 'smh', 'ngl', 'tbh', 'bruh', 'bro', 'sus', 'nocap', 'finna', 'deadass', 'ong', 'fr', 'frfr', 'yeet', 'simp', 'rizz', 'gyat', 'gyatt', 'sigma', 'skibidi', 'ratio', 'idk', 'idc', 'omg', 'omfg', 'istg', 'ily', 'ttyl', 'brb', 'lowkey', 'highkey', 'slay', 'bussin', 'noob', 'nub', 'scrub', 'ez', 'cringe', 'fam', 'thot', 'yolo', 'irl', 'imo', 'imho', 'jk', 'pov', 'ok boomer', 'boomer', 'zoomer', 'ur', 'u', 'ya', 'yall', 'gonna', 'wanna', 'gotta', 'aint', 'dawg', 'homie', 'rekt', 'pwned', 'clapped', 'cooked', 'npc', 'touch grass'];
  const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g', '2': 'z' };
  const norm = w => w.toLowerCase().split('').map(ch => LEET[ch] || ch).join('').replace(/[^a-z]/g, '').replace(/(.)\1{2,}/g, '$1$1');
  const squash = w => w.replace(/(.)\1+/g, '$1');
  const SET_EXACT = new Set(PROFANE_EXACT), SET_SOCIAL = new Set(SOCIAL.filter(s => !s.includes(' '))), SET_SLANG = new Set(SLANG.filter(s => !s.includes(' '))), SET_SAFE = new Set(SAFE);
  const PHRASES = SOCIAL.concat(SLANG).filter(s => s.includes(' '));
  function badWord(w) {
    const n = norm(w), q = squash(n); if (!n) return false;
    if (SET_SAFE.has(n)) return false;
    if (SET_EXACT.has(n) || SET_EXACT.has(q) || SET_SOCIAL.has(n) || SET_SLANG.has(n) || SET_SLANG.has(q)) return true;
    for (const r of PROFANE_ROOTS) if (n.includes(r) || q.includes(squash(r))) return true;
    return false;
  }
  function clean(text, max = 80) {
    let t = String(text == null ? '' : text).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').normalize('NFKC').slice(0, max * 2).trim();
    // links, emails, @handles, #tags and phone numbers
    t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, m => '*'.repeat(m.length))
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, m => '*'.repeat(m.length))
      .replace(/\b[\w-]+\s*(?:\.|\(dot\)|\[dot\]| dot )\s*(?:com|net|org|gg|io|me|tv|co|xyz|app|ly|link|us|uk|ca)\b(?:\/\S*)?/gi, m => '*'.repeat(m.length))
      .replace(/[@#][\w.]{2,}/g, m => '*'.repeat(m.length))
      .replace(/(?:\+?\d[\s\-.()]*){7,}/g, m => '*'.repeat(m.replace(/\s/g, '').length));
    // multi-word phrases
    for (const p of PHRASES) { const re = new RegExp('\\b' + p.replace(/ /g, '\\s+') + '\\b', 'gi'); t = t.replace(re, m => '*'.repeat(m.length)); }
    // spaced-out words like "f u c k" or "s.h.i.t"
    t = t.replace(/\b(?:[a-z0-9@$!|][\s._\-*]+){2,}[a-z0-9@$!|]\b/gi, m => badWord(m) ? '*'.repeat(m.length) : m);
    // word by word
    t = t.split(/(\s+)/).map(tok => /\s/.test(tok) ? tok : (badWord(tok) ? '*'.repeat(Math.max(3, tok.length)) : tok)).join('');
    t = t.replace(/\s+/g, ' ').trim().slice(0, max);
    return t;
  }
  const QUICK = ['Hello!', 'Good game!', 'Nice one!', 'Team up?', 'Help!', 'Watch out!', 'Boss here!', 'Thanks!', 'Follow me to the boss!', 'Sorry!'];
  const api = { clean, badWord, QUICK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ChatFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
