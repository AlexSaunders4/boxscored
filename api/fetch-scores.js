// api/fetch-scores.js
// Vercel serverless function
// Fetches ESPN scoreboard + box scores and upserts to Supabase
// Deploy to Vercel, then call via cron or manual trigger

const SUPABASE_URL = 'https://tlgbwbnaireajoktwvnf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZ2J3Ym5haXJlYWpva3R3dm5mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4MDAwMTYsImV4cCI6MjA4OTM3NjAxNn0.lTEIKrHjrnkuZkLhIZ-Vc0W4k_CeojtzfV6IT1fnH5o';

// ESPN endpoints for each league
const LEAGUES = [
  { league: 'NBA',  sport: 'basketball', espnSport: 'basketball', espnLeague: 'nba'   },
  { league: 'NFL',  sport: 'football',   espnSport: 'football',   espnLeague: 'nfl'   },
  { league: 'NHL',  sport: 'hockey',     espnSport: 'hockey',     espnLeague: 'nhl'   },
  { league: 'MLB',  sport: 'baseball',   espnSport: 'baseball',   espnLeague: 'mlb'   },
  { league: 'WNBA', sport: 'basketball', espnSport: 'basketball', espnLeague: 'wnba'  },
  { league: 'EPL',  sport: 'soccer',     espnSport: 'soccer',     espnLeague: 'eng.1' },
  { league: 'UCL',  sport: 'soccer',     espnSport: 'soccer',     espnLeague: 'uefa.champions' },
  { league: 'MLS',  sport: 'soccer',     espnSport: 'soccer',     espnLeague: 'usa.1' },
];

// ── SUPABASE HELPER ──
async function supabase(method, table, body, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=minimal,resolution=merge-duplicates' : method === 'DELETE' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${table}${params}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── ESPN FETCH HELPER ──
async function espnFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BoxScored/1.0' },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${url} → ${res.status}`);
  return res.json();
}

// ── PARSE STATUS ──
function parseStatus(event) {
  const s = event.status?.type?.name || '';
  const completed = ['STATUS_FINAL','STATUS_FULL_TIME','STATUS_FULL_PEN',
    'STATUS_POSTPONED','STATUS_CANCELED','STATUS_FORFEIT'];
  const inProgress = ['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD',
    'STATUS_DELAY','STATUS_RAIN_DELAY','STATUS_OVERTIME'];
  if (completed.includes(s)) return 'final';
  if (inProgress.includes(s)) return 'live';
  return 'scheduled';
}

function parsePeriod(event) {
  const detail = event.status?.type?.shortDetail || '';
  return detail;
}

function parseClock(event) {
  return event.status?.displayClock || null;
}

// ── DATE HELPERS ──
function getTodayDate() {
  return new Date().toISOString().split('T')[0].replace(/-/g, '');
}
function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

// ── FETCH SCOREBOARD FOR ONE LEAGUE (with optional date) ──
async function fetchScoreboardForDate(leagueConfig, date) {
  const { espnSport, espnLeague } = leagueConfig;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/scoreboard?dates=${date}`;
  return fetchScoreboardFromUrl(leagueConfig, url);
}

async function fetchScoreboard(leagueConfig) {
  const { espnSport, espnLeague } = leagueConfig;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/scoreboard`;
  return fetchScoreboardFromUrl(leagueConfig, url);
}

// ── FETCH SCOREBOARD FOR ONE LEAGUE ──
async function fetchScoreboardFromUrl(leagueConfig, url) {
  const { league, sport, espnSport, espnLeague } = leagueConfig;
  const data = await espnFetch(url);
  const events = data.events || [];

  const games = events.map(event => {
    const comp = event.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) return null;

    const status = parseStatus(event);

    return {
      espn_id:     event.id,
      league,
      sport,
      home_team:   home.team.displayName || home.team.name,
      away_team:   away.team.displayName || away.team.name,
      home_abbr:   home.team.abbreviation,
      away_abbr:   away.team.abbreviation,
      home_score:  status !== 'scheduled' ? parseInt(home.score) || 0 : null,
      away_score:  status !== 'scheduled' ? parseInt(away.score) || 0 : null,
      status,
      start_time:  event.date,
      game_date:   event.date?.split('T')[0],
      venue:       comp.venue?.fullName || null,
      home_record: home.records?.[0]?.summary || null,
      away_record: away.records?.[0]?.summary || null,
      period:      parsePeriod(event),
      clock:       parseClock(event),
      updated_at:  new Date().toISOString(),
    };
  }).filter(Boolean);

  return { games, events };
}

// ── FETCH BOX SCORE FOR ONE GAME ──
async function fetchBoxScore(espnGame, leagueConfig) {
  const { espn_id, sport } = espnGame;
  const { espnSport, espnLeague } = leagueConfig;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/summary?event=${espn_id}`;

  let data;
  try {
    data = await espnFetch(url);
  } catch (e) {
    console.warn(`Box score fetch failed for ${espn_id}: ${e.message}`);
    return;
  }

  const boxscores = data.boxscore?.players || [];
  if (!boxscores.length) return;

  if (sport === 'basketball') await parseBasketball(espn_id, boxscores);
  else if (sport === 'football')  await parseFootball(espn_id, boxscores, data);
  else if (sport === 'baseball')  await parseBaseball(espn_id, boxscores);
  else if (sport === 'hockey')    await parseHockey(espn_id, boxscores);
  else if (sport === 'soccer')    await parseSoccer(espn_id, boxscores);
}

// ── BASKETBALL BOX SCORE ──
// Helper: safely parse int, always returns integer never null
function safeInt(val) { const n = parseInt(val); return isNaN(n) ? 0 : n; }
function safeStr(val) { return val != null ? String(val) : ''; }
function safeSplit(str, sep, idx) {
  if (!str) return 0;
  const parts = str.split(sep);
  return safeInt(parts[idx]);
}

async function parseBasketball(espnGameId, boxscores) {
  const rows = [];
  for (const team of boxscores) {
    const teamAbbr = safeStr(team.team?.abbreviation);
    const statsLabels = team.statistics?.[0]?.labels || [];
    const athletes = team.statistics?.[0]?.athletes || [];

    for (const athlete of athletes) {
      // Skip DNP players who have empty stats arrays
      if (!athlete.stats || athlete.stats.length === 0) continue;
      const stats = athlete.stats;
      const get = (label) => {
        const idx = statsLabels.indexOf(label);
        return (idx >= 0 && stats[idx] != null) ? stats[idx] : '';
      };
      const fgStr = get('FG') || '0-0';
      const tpStr = get('3PT') || '0-0';
      const ftStr = get('FT') || '0-0';

      // Every field must be non-null and same type across all rows
      rows.push({
        espn_game_id: safeStr(espnGameId),
        player_name:  safeStr(athlete.athlete?.displayName) || 'Unknown',
        team_abbr:    teamAbbr,
        position:     safeStr(athlete.athlete?.position?.abbreviation),
        starter:      athlete.starter === true,
        min:          safeStr(get('MIN')),
        pts:          safeInt(get('PTS')),
        reb:          safeInt(get('REB')),
        ast:          safeInt(get('AST')),
        stl:          safeInt(get('STL')),
        blk:          safeInt(get('BLK')),
        to_val:       safeInt(get('TO')),
        oreb:         safeInt(get('OREB')),
        dreb:         safeInt(get('DREB')),
        pf:           safeInt(get('PF')),
        pm:           safeInt(get('+/-')),
        fg_made:      safeSplit(fgStr, '-', 0),
        fg_att:       safeSplit(fgStr, '-', 1),
        tp_made:      safeSplit(tpStr, '-', 0),
        tp_att:       safeSplit(tpStr, '-', 1),
        ft_made:      safeSplit(ftStr, '-', 0),
        ft_att:       safeSplit(ftStr, '-', 1),
      });
    }
  }
  if (rows.length) {
    await supabase('DELETE', 'box_basketball', null, '?espn_game_id=eq.' + espnGameId);
    // Insert in batches of 25 to avoid request size limits
    for (let i = 0; i < rows.length; i += 25) {
      await supabase('POST', 'box_basketball', rows.slice(i, i + 25));
    }
  }
}

// ── FOOTBALL BOX SCORE ──
async function parseFootball(espnGameId, boxscores, data) {
  const skillRows = [];
  const defRows = [];

  for (const team of boxscores) {
    const teamAbbr = team.team?.abbreviation || '';
    for (const statGroup of (team.statistics || [])) {
      const labels = statGroup.labels || [];
      const category = statGroup.name?.toLowerCase() || '';

      for (const athlete of (statGroup.athletes || [])) {
        const stats = athlete.stats || [];
        const get = (label) => {
          const idx = labels.indexOf(label);
          return idx >= 0 ? stats[idx] : null;
        };
        const playerName = athlete.athlete?.displayName || 'Unknown';
        const position = athlete.athlete?.position?.abbreviation || null;

        if (category === 'passing') {
          const cmpAtt = (get('C/ATT') || '0/0').split('/');
          skillRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            pass_cmp: parseInt(cmpAtt[0]) || 0,
            pass_att: parseInt(cmpAtt[1]) || 0,
            pass_yds: parseInt(get('YDS')) || 0,
            pass_td:  parseInt(get('TD'))  || 0,
            pass_int: parseInt(get('INT')) || 0,
            pass_rtg: parseFloat(get('RTG')) || null,
            sacked:   parseInt(get('SCK')) || 0,
          });
        } else if (category === 'rushing') {
          skillRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            rush_car: parseInt(get('CAR')) || 0,
            rush_yds: parseInt(get('YDS')) || 0,
            rush_avg: parseFloat(get('AVG')) || null,
            rush_td:  parseInt(get('TD'))  || 0,
            rush_lng: parseInt(get('LNG')) || 0,
          });
        } else if (category === 'receiving') {
          skillRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            rec:     parseInt(get('REC')) || 0,
            rec_tgt: parseInt(get('TGT')) || 0,
            rec_yds: parseInt(get('YDS')) || 0,
            rec_avg: parseFloat(get('AVG')) || null,
            rec_td:  parseInt(get('TD'))  || 0,
            rec_lng: parseInt(get('LNG')) || 0,
          });
        } else if (category === 'defensive' || category === 'defense') {
          defRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            tackles: parseInt(get('TOT')) || 0,
            solo:    parseInt(get('SOLO')) || 0,
            sacks:   parseFloat(get('SACKS')) || 0,
            tfl:     parseFloat(get('TFL')) || 0,
            int_val: parseInt(get('INT')) || 0,
            pd:      parseInt(get('PD'))  || 0,
            ff:      parseInt(get('FF'))  || 0,
            fr:      parseInt(get('FR'))  || 0,
            td:      parseInt(get('TD'))  || 0,
          });
        }
      }
    }
  }

  if (skillRows.length) {
    await supabase('DELETE', 'box_football_skill', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_football_skill', skillRows);
  }
  if (defRows.length) {
    await supabase('DELETE', 'box_football_defense', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_football_defense', defRows);
  }
}

// ── BASEBALL BOX SCORE ──
async function parseBaseball(espnGameId, boxscores) {
  const batRows = [];
  const pitRows = [];

  for (const team of boxscores) {
    const teamAbbr = team.team?.abbreviation || '';
    for (const statGroup of (team.statistics || [])) {
      const labels = statGroup.labels || [];
      const category = statGroup.name?.toLowerCase() || '';

      for (const athlete of (statGroup.athletes || [])) {
        const stats = athlete.stats || [];
        const get = (label) => {
          const idx = labels.indexOf(label);
          return idx >= 0 ? stats[idx] : null;
        };
        const playerName = athlete.athlete?.displayName || 'Unknown';
        const position = athlete.athlete?.position?.abbreviation || null;

        if (category === 'batting') {
          batRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            batting_order: athlete.batOrder || null,
            ab:      parseInt(get('AB'))  || 0,
            runs:    parseInt(get('R'))   || 0,
            hits:    parseInt(get('H'))   || 0,
            rbi:     parseInt(get('RBI')) || 0,
            bb:      parseInt(get('BB'))  || 0,
            so:      parseInt(get('SO'))  || 0,
            hr:      parseInt(get('HR'))  || 0,
            avg:     get('AVG'),
            obp:     get('OBP'),
            slg:     get('SLG'),
          });
        } else if (category === 'pitching') {
          pitRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr,
            win_loss:     get('W/L') || get('DEC') || null,
            ip:           get('IP'),
            hits_allowed: parseInt(get('H'))  || 0,
            runs_allowed: parseInt(get('R'))  || 0,
            earned_runs:  parseInt(get('ER')) || 0,
            bb:           parseInt(get('BB')) || 0,
            so:           parseInt(get('SO')) || 0,
            hr_allowed:   parseInt(get('HR')) || 0,
            era:          get('ERA'),
            pitch_count:  parseInt(get('PC')) || null,
            strikes:      parseInt(get('ST')) || null,
          });
        }
      }
    }
  }

  if (batRows.length) {
    await supabase('DELETE', 'box_baseball_batting', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_baseball_batting', batRows);
  }
  if (pitRows.length) {
    await supabase('DELETE', 'box_baseball_pitching', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_baseball_pitching', pitRows);
  }
}

// ── HOCKEY BOX SCORE ──
async function parseHockey(espnGameId, boxscores) {
  const skaterRows = [];
  const goalieRows = [];

  for (const team of boxscores) {
    const teamAbbr = team.team?.abbreviation || '';
    for (const statGroup of (team.statistics || [])) {
      const labels = statGroup.labels || [];
      const category = statGroup.name?.toLowerCase() || '';

      for (const athlete of (statGroup.athletes || [])) {
        const stats = athlete.stats || [];
        const get = (label) => {
          const idx = labels.indexOf(label);
          return idx >= 0 ? stats[idx] : null;
        };
        const playerName = athlete.athlete?.displayName || 'Unknown';
        const position = athlete.athlete?.position?.abbreviation || null;

        if (category === 'goalies' || position === 'G') {
          goalieRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr,
            decision: get('DEC') || null,
            sa:       parseInt(get('SA'))  || 0,
            sv:       parseInt(get('SV'))  || 0,
            ga:       parseInt(get('GA'))  || 0,
            sv_pct:   get('SV%'),
            toi:      get('TOI'),
            pim:      parseInt(get('PIM')) || 0,
          });
        } else {
          skaterRows.push({
            espn_game_id: espnGameId, player_name: playerName,
            team_abbr: teamAbbr, position,
            goals:    parseInt(get('G'))   || 0,
            assists:  parseInt(get('A'))   || 0,
            points:   parseInt(get('PTS')) || 0,
            pm:       parseInt(get('+/-')) || 0,
            pim:      parseInt(get('PIM')) || 0,
            sog:      parseInt(get('SOG')) || 0,
            toi:      get('TOI'),
            hits:     parseInt(get('HIT')) || 0,
            blk:      parseInt(get('BLK')) || 0,
          });
        }
      }
    }
  }

  if (skaterRows.length) {
    await supabase('DELETE', 'box_hockey_skaters', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_hockey_skaters', skaterRows);
  }
  if (goalieRows.length) {
    await supabase('DELETE', 'box_hockey_goalies', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_hockey_goalies', goalieRows);
  }
}

// ── SOCCER BOX SCORE ──
async function parseSoccer(espnGameId, boxscores) {
  const rows = [];
  for (const team of boxscores) {
    const teamAbbr = team.team?.abbreviation || '';
    const statGroup = team.statistics?.[0];
    if (!statGroup) continue;
    const labels = statGroup.labels || [];

    for (const athlete of (statGroup.athletes || [])) {
      const stats = athlete.stats || [];
      const get = (label) => {
        const idx = labels.indexOf(label);
        return idx >= 0 ? stats[idx] : null;
      };

      rows.push({
        espn_game_id:   espnGameId,
        player_name:    athlete.athlete?.displayName || 'Unknown',
        team_abbr:      teamAbbr,
        position:       athlete.athlete?.position?.abbreviation || null,
        min_played:     parseInt(get('MIN')) || 0,
        goals:          parseInt(get('G'))   || 0,
        assists:        parseInt(get('A'))   || 0,
        shots_on:       parseInt(get('SOG')) || 0,
        shots_total:    parseInt(get('SH'))  || 0,
        pass_pct:       get('PS%'),
        key_passes:     parseInt(get('KP'))  || 0,
        tackles:        parseInt(get('TKL')) || 0,
        interceptions:  parseInt(get('INT')) || 0,
        yellow_cards:   parseInt(get('YC'))  || 0,
        red_cards:      parseInt(get('RC'))  || 0,
        rating:         get('RTG'),
      });
    }
  }

  if (rows.length) {
    await supabase('DELETE', 'box_soccer', null, `?espn_game_id=eq.${espnGameId}`);
    await supabase('POST', 'box_soccer', rows);
  }
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  // Allow manual trigger via GET, or cron via any method
  const leagueFilter = req.query?.league; // optional: ?league=NBA
  const results = { updated: [], errors: [], boxScores: 0 };

  const toProcess = leagueFilter
    ? LEAGUES.filter(l => l.league === leagueFilter.toUpperCase())
    : LEAGUES;

  for (const leagueConfig of toProcess) {
    try {
      // Fetch today AND yesterday scoreboard
      const dates = [getTodayDate(), getYesterdayDate()];
      let allGames = [];

      for (const date of dates) {
        try {
          console.log(`Fetching ${leagueConfig.league} scoreboard for ${date}...`);
          const { games } = await fetchScoreboardForDate(leagueConfig, date);
          allGames = allGames.concat(games);
        } catch (e) {
          console.warn(`Scoreboard fetch failed for ${leagueConfig.league} ${date}: ${e.message}`);
        }
      }

      // Deduplicate by espn_id
      const seen = new Set();
      allGames = allGames.filter(g => {
        if (seen.has(g.espn_id)) return false;
        seen.add(g.espn_id);
        return true;
      });

      if (!allGames.length) {
        console.log(`No games found for ${leagueConfig.league}`);
        continue;
      }

      // Upsert all games
      await supabase('POST', 'games', allGames, '?on_conflict=espn_id');
      results.updated.push(`${leagueConfig.league}: ${allGames.length} games`);

      // Fetch box scores for all final/live games
      const activeGames = allGames.filter(g => g.status === 'live' || g.status === 'final');
      console.log(`${leagueConfig.league}: ${activeGames.length} active games need box scores`);
      results.updated.push(`${leagueConfig.league} active: ${activeGames.length} games needing box scores`);

      for (const game of activeGames) {
        try {
          await fetchBoxScore(game, leagueConfig);
          results.boxScores++;
        } catch (e) {
          const msg = `Box score failed ${game.espn_id}: ${e.message}`;
          console.warn(msg);
          results.errors.push(msg);
        }
      }

    } catch (e) {
      console.error(`${leagueConfig.league} failed: ${e.message}`);
      results.errors.push(`${leagueConfig.league}: ${e.message}`);
    }
  }

  console.log('Done:', results);
  res.status(200).json({ ok: true, ...results });
}
