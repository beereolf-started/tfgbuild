// Wave mechanic: scheduled creature invasions per player.
// Schedule (from first login, counted in in-game days):
//   Wave 1  — day 30  (1 month)  — 5 creatures
//   Wave 2  — day 180 (6 months) — 10 creatures
//   Wave 3+ — day 360, 720, 1080... (every year) — 20 creatures
// Warning: daily chat + title for 14 days before each wave.

let WSRV = null

const WS_DAY           = 24000  // ticks in one MC day
const WAVE_1_DAY      = 30     // days from origin
const WAVE_2_DAY      = 180
const WAVE_YEAR_DAYS  = 360    // repeat period for waves 3+
const WARN_DAYS       = 14     // warning window in days
const CHECK_EVERY     = 2400   // ticks between checks (2 min)

// Entity pools (escalating difficulty)
const WAVE_POOL_1 = [
    "iceandfire:troll", "iceandfire:hippogryph", "iceandfire:stymphalian_bird",
    "iceandfire:cockatrice", "iceandfire:amphithere",
]
const WAVE_POOL_2 = [
    "iceandfire:gorgon", "iceandfire:cyclops", "iceandfire:ghost",
    "iceandfire:troll", "iceandfire:amphithere", "iceandfire:dread_ghoul",
    "iceandfire:myrmex_soldier", "iceandfire:siren",
]
const WAVE_POOL_3 = [
    "iceandfire:dread_knight", "iceandfire:dread_lich", "iceandfire:dread_beast",
    "iceandfire:gorgon", "iceandfire:cyclops", "iceandfire:ghost",
    "iceandfire:dread_scuttler", "iceandfire:dread_thrall", "iceandfire:dread_horse",
]

function wlog(msg) { console.info("[tfg-wave] " + msg) }

// Tick of the next wave, given how many have already fired and the origin tick.
function wsNextWaveTick(fired, origin) {
    if (fired === 0) return origin + WAVE_1_DAY * WS_DAY
    if (fired === 1) return origin + WAVE_2_DAY * WS_DAY
    // waves 3+: year 1, year 2, ... = days 360, 720, 1080...
    return origin + (fired - 1) * WAVE_YEAR_DAYS * WS_DAY
}
function wsWaveSize(fired) {
    if (fired === 0) return 5
    if (fired === 1) return 10
    return 20
}
function wavePool(fired) {
    if (fired === 0) return WAVE_POOL_1
    if (fired === 1) return WAVE_POOL_2
    return WAVE_POOL_3
}

function spawnWave(player, size, pool) {
    var name = player.username
    var lvl = player.level
    wlog(name + ": spawning wave of " + size)
    var done = 0
    for (var wi = 0; wi < size; wi++) {
        var ent = pool[Math.floor(Math.random() * pool.length)]
        // Расстановка общая с danger_spawns.js: высота по карте высот (раньше твари
        // появлялись на высоте игрока и задыхались в скале), водные - только в воде.
        // Волна идёт на базу, поэтому свет факелов её не останавливает.
        var spot = iafFindSpot(lvl, player.blockX, player.blockZ, ent, 15, 25, true)
        if (!spot && IAF_AQUATIC[ent]) {
            var land = pool.filter(p => !IAF_AQUATIC[p])
            ent = land[Math.floor(Math.random() * land.length)]
            spot = iafFindSpot(lvl, player.blockX, player.blockZ, ent, 15, 25, true)
        }
        if (spot && iafSummonAt(WSRV, name, ent, spot, ["tfg_managed", "tfg_wave"])) done++
    }
    wlog(name + ": wave spawned " + done + "/" + size)
}

function sendWarning(name, daysLeft) {
    WSRV.runCommandSilent(
        'tellraw @a[name=' + name + '] [{"text":"[Нашествие] ","color":"dark_red","bold":true},{"text":"До волны тварей: ' + daysLeft + ' дн.","color":"red"}]'
    )
    WSRV.runCommandSilent('title @a[name=' + name + '] times 10 80 20')
    WSRV.runCommandSilent(
        'title @a[name=' + name + '] subtitle {"text":"До нашествия: ' + daysLeft + ' дн.","color":"gold"}'
    )
    WSRV.runCommandSilent(
        'title @a[name=' + name + '] title {"text":"\\u26a0 Волна надвигается \\u26a0","color":"dark_red","bold":true}'
    )
}

function sendArrival(name) {
    WSRV.runCommandSilent(
        'tellraw @a[name=' + name + '] {"text":"[Нашествие] Волна тварей обрушилась на вас!","color":"dark_red","bold":true}'
    )
    WSRV.runCommandSilent('title @a[name=' + name + '] times 5 120 20')
    WSRV.runCommandSilent(
        'title @a[name=' + name + '] subtitle {"text":"Выживите любой ценой!","color":"red"}'
    )
    WSRV.runCommandSilent(
        'title @a[name=' + name + '] title {"text":"НАШЕСТВИЕ!","color":"dark_red","bold":true}'
    )
}

// Игровое время - явным getGameTime() с проверкой. Обращение .gameTime давало
// NaN, и putLong(NaN) падал при каждой проверке (79 ошибок в логе KubeJS) -
// волны не срабатывали ни разу.
function wsGameTime(server, level) {
    var t = NaN
    try { t = Number(level.getGameTime()) } catch (e) { }
    if (isFinite(t)) return t
    try { t = Number(server.runCommandSilent("time query gametime")) } catch (e) { }
    return isFinite(t) ? t : null
}

ServerEvents.tick(event => {
    if (!WSRV) WSRV = event.server
    if (event.server.tickCount % CHECK_EVERY !== 0) return

    event.server.players.forEach(player => {
        try {
            var name = player.username
            var gameTime = wsGameTime(event.server, player.level)
            if (gameTime === null) return
            var pd = player.persistentData

            // set wave origin on first encounter
            if (!pd.contains("tfg_wave_origin")) {
                pd.putLong("tfg_wave_origin", gameTime)
                wlog(name + ": origin set, day " + Math.floor(gameTime / WS_DAY))
                return
            }

            var origin = Number(pd.getLong("tfg_wave_origin"))
            var fired  = pd.getInt("tfg_wave_count")   // waves already fired
            var nextT  = wsNextWaveTick(fired, origin)
            var warnT  = nextT - WARN_DAYS * WS_DAY

            // fire wave
            if (gameTime >= nextT) {
                sendArrival(name)
                spawnWave(player, wsWaveSize(fired), wavePool(fired))
                pd.putInt("tfg_wave_count", fired + 1)
                pd.remove("tfg_wave_warn_day")
                wlog(name + ": wave " + (fired + 1) + " fired, size=" + wsWaveSize(fired))
                return
            }

            // daily warning in window
            if (gameTime >= warnT) {
                var curDay      = Math.floor(gameTime / WS_DAY)
                var lastWarnDay = pd.getInt("tfg_wave_warn_day")
                if (curDay !== lastWarnDay) {
                    var daysLeft = Math.ceil((nextT - gameTime) / WS_DAY)
                    sendWarning(name, daysLeft)
                    pd.putInt("tfg_wave_warn_day", curDay)
                    wlog(name + ": warning sent, " + daysLeft + " days left")
                }
            }
        } catch (e) {
            console.info("[tfg-wave] error for " + player.username + ": " + e)
        }
    })
})

console.info("[tfg-wave] loaded")
