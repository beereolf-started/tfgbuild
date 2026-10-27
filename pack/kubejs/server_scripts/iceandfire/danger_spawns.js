// ============================================================================
// Danger-tier spawn system v2 (Stage 2 mechanics).
//   - pack spawning (non-bosses come in groups)
//   - loaded cap: category `max` is also the max simultaneously-loaded mobs
//     near the player (tagged tfg_managed, counted within LOADED_RADIUS)
//   - geographic kill-cooldown: every kill drops a self-expiring marker
//     (area_effect_cloud) tagged tfg_kill_<type> at the corpse; once >= KILL
//     markers of a type are near the player, that type stops spawning there
//   - bosses are solitary (no pack), threshold 1, cooldown x2
//   - weather still pushes boss chance up
// Cooldowns are real day-scaled values (see COOLDOWN_BY_TIER). AEC markers only
// tick down while their chunk is loaded, so a cleared area stays cleared until
// enough loaded-time passes - which matches "the area stays quiet for a day+".
// ============================================================================

const BIOME_CATEGORY = {
    "tfg:earth/plains": "calm", "tfg:earth/hills": "calm", "tfg:earth/rolling_hills": "calm",
    "tfg:earth/terrace_lower": "calm", "tfg:earth/terrace_upper": "calm", "tfg:earth/drumlins": "calm",
    "tfg:earth/knob_and_kettle": "calm", "tfg:earth/patterned_ground": "calm",
    "tfg:earth/inverted_patterned_ground": "calm", "tfg:earth/stone_circles": "calm",
    "tfg:earth/plateau": "calm", "tfg:earth/plateau_lake": "calm", "tfg:earth/plateau_wide": "calm",

    "tfg:earth/old_mountains": "moderate", "tfg:earth/mountains": "moderate", "tfg:earth/highlands": "moderate",
    "tfg:earth/rocky_plateau": "moderate", "tfg:earth/mountain_lake": "moderate",
    "tfg:earth/oceanic_mountain_lake": "moderate", "tfg:earth/old_mountain_lake": "moderate",
    "tfg:earth/oceanic_mountains": "moderate",

    "tfg:earth/ice_sheet": "cold", "tfg:earth/ice_sheet_edge": "cold", "tfg:earth/ice_sheet_mountains": "cold",
    "tfg:earth/ice_sheet_mountains_edge": "cold", "tfg:earth/ice_sheet_oceanic": "cold",
    "tfg:earth/ice_sheet_oceanic_mountains": "cold", "tfg:earth/ice_sheet_oceanic_mountains_edge": "cold",
    "tfg:earth/ice_sheet_shield_volcano": "cold", "tfg:earth/ice_sheet_shore": "cold",
    "tfg:earth/ice_sheet_tuyas": "cold", "tfg:earth/ice_sheet_tuyas_edge": "cold",
    "tfg:earth/glaciated_mountains": "cold", "tfg:earth/glaciated_oceanic_mountains": "cold",
    "tfg:earth/glacially_carved_mountains": "cold", "tfg:earth/glacially_carved_oceanic_mountains": "cold",
    "tfg:earth/subglacial_lake": "cold", "tfg:earth/meltwater_lake": "cold",

    "tfg:earth/active_shield_volcano": "volcanic", "tfg:earth/ancient_shield_volcano": "volcanic",
    "tfg:earth/dormant_shield_volcano": "volcanic", "tfg:earth/extinct_shield_volcano": "volcanic",
    "tfg:earth/glaciated_shield_volcano": "volcanic", "tfg:earth/old_shield_volcano_shore": "volcanic",
    "tfg:earth/shield_volcano_shore": "volcanic", "tfg:earth/sunken_shield_volcano": "volcanic",
    "tfg:earth/tuyas": "volcanic", "tfg:earth/volcanic_mountains": "volcanic",
    "tfg:earth/volcanic_oceanic_mountains": "volcanic", "tfg:earth/volcanic_mountain_lake": "volcanic",
    "tfg:earth/volcanic_oceanic_mountain_lake": "volcanic",

    "tfg:earth/extreme_doline_mountains": "storm", "tfg:earth/extreme_doline_plateau": "storm",

    "tfg:earth/badlands": "desert", "tfg:earth/canyons": "desert", "tfg:earth/low_canyons": "desert",
    "tfg:earth/mesas": "desert", "tfg:earth/hoodoos": "desert", "tfg:earth/buttes": "desert",
    "tfg:earth/stair_step_canyons": "desert", "tfg:earth/whorled_canyons": "desert",
    "tfg:earth/setback_cliffs": "desert", "tfg:earth/dune_sea": "desert", "tfg:earth/grassy_dunes": "desert",
    "tfg:earth/coastal_dunes": "desert", "tfg:earth/salt_flats": "desert",

    "tfg:earth/burren_badlands": "karst", "tfg:earth/burren_badlands_tall": "karst",
    "tfg:earth/burren_plains": "karst", "tfg:earth/burren_plateau": "karst",
    "tfg:earth/burren_roche_moutonee": "karst", "tfg:earth/cenote_canyons": "karst",
    "tfg:earth/cenote_highlands": "karst", "tfg:earth/cenote_hills": "karst",
    "tfg:earth/cenote_plains": "karst", "tfg:earth/cenote_plateau": "karst",
    "tfg:earth/cenote_rolling_hills": "karst", "tfg:earth/doline_canyons": "karst",
    "tfg:earth/doline_highlands": "karst", "tfg:earth/doline_hills": "karst",
    "tfg:earth/doline_plains": "karst", "tfg:earth/doline_plateau": "karst",
    "tfg:earth/doline_rolling_hills": "karst", "tfg:earth/shilin_canyons": "karst",
    "tfg:earth/shilin_highlands": "karst", "tfg:earth/shilin_hills": "karst",
    "tfg:earth/shilin_plains": "karst", "tfg:earth/shilin_plateau": "karst",
    "tfg:earth/tower_karst_bay": "karst", "tfg:earth/tower_karst_canyons": "karst",
    "tfg:earth/tower_karst_highlands": "karst", "tfg:earth/tower_karst_hills": "karst",
    "tfg:earth/tower_karst_lake": "karst", "tfg:earth/tower_karst_plains": "karst",

    "tfg:earth/lowlands": "wetland", "tfg:earth/salt_marsh": "wetland", "tfg:earth/mud_flats": "wetland",
    "tfg:earth/tidal_flats": "wetland", "tfg:earth/embayments": "wetland", "tfg:earth/river": "wetland",

    "tfg:earth/ocean": "ocean", "tfg:earth/ocean_reef": "ocean", "tfg:earth/deep_ocean": "ocean",
    "tfg:earth/deep_ocean_trench": "ocean", "tfg:earth/shore": "ocean", "tfg:earth/rocky_shores": "ocean",
    "tfg:earth/sea_stacks": "ocean", "tfg:earth/guano_island": "ocean", "tfg:earth/lake": "ocean",
}

const CATEGORIES = {
    calm:     { level: 1, max: 1, boss: null,                     entities: ["iceandfire:hippogryph", "iceandfire:pixie"] },
    moderate: { level: 1, max: 1, boss: null,                     entities: ["iceandfire:troll", "iceandfire:hippogryph", "iceandfire:stymphalian_bird", "iceandfire:gorgon"] },
    ocean:    { level: 1, max: 1, boss: "iceandfire:sea_serpent", entities: ["iceandfire:hippocampus", "iceandfire:amphithere", "iceandfire:siren"] },

    wetland:  { level: 2, max: 2, boss: null,                     entities: ["iceandfire:amphithere", "iceandfire:siren", "iceandfire:cockatrice", "iceandfire:myrmex_worker", "iceandfire:troll", "iceandfire:gorgon", "iceandfire:ghost"] },
    karst:    { level: 2, max: 2, boss: "iceandfire:hydra",       entities: ["iceandfire:cyclops", "iceandfire:myrmex_worker", "iceandfire:myrmex_soldier", "iceandfire:gorgon", "iceandfire:ghost", "iceandfire:dread_thrall", "iceandfire:dread_ghoul"] },
    desert:   { level: 2, max: 2, boss: null,                     entities: ["iceandfire:deathworm", "iceandfire:cockatrice", "iceandfire:myrmex_worker", "iceandfire:myrmex_soldier", "iceandfire:myrmex_swarmer", "iceandfire:gorgon"] },
    cold:     { level: 2, max: 2, boss: "iceandfire:ice_dragon",  entities: ["iceandfire:troll", "iceandfire:dread_thrall", "iceandfire:dread_ghoul", "iceandfire:dread_beast", "iceandfire:dread_scuttler", "iceandfire:dread_horse", "iceandfire:dread_knight", "iceandfire:dread_lich"] },

    volcanic: { level: 3, max: 3, boss: "iceandfire:fire_dragon",      entities: ["iceandfire:cockatrice", "iceandfire:dread_beast"] },
    storm:    { level: 3, max: 3, boss: "iceandfire:lightning_dragon", entities: ["iceandfire:troll", "iceandfire:hippogryph", "iceandfire:stymphalian_bird"] },
}

// pack sizes for non-boss creatures (default 1)
const PACK_SIZES = {
    // pack sizes ≤ 2 — swarms are built by repeated cycles, not single dumps
    "iceandfire:troll": 1, "iceandfire:myrmex_worker": 2, "iceandfire:cockatrice": 1,
    "iceandfire:amphithere": 1, "iceandfire:stymphalian_bird": 2, "iceandfire:hippogryph": 1,
    "iceandfire:deathworm": 1, "iceandfire:pixie": 2, "iceandfire:siren": 1, "iceandfire:hippocampus": 1,
    "iceandfire:cyclops": 1, "iceandfire:sea_serpent": 1,
    "iceandfire:gorgon": 1, "iceandfire:ghost": 1,
    "iceandfire:myrmex_soldier": 2, "iceandfire:myrmex_swarmer": 2,
    "iceandfire:dread_thrall": 2, "iceandfire:dread_ghoul": 1, "iceandfire:dread_beast": 1,
    "iceandfire:dread_scuttler": 2, "iceandfire:dread_horse": 1, "iceandfire:dread_knight": 1,
    "iceandfire:dread_lich": 1, "iceandfire:dread_queen": 1, "iceandfire:black_frost_dragon": 1,
}

const BOSS_SET = {
    "fire_dragon": 1, "ice_dragon": 1, "lightning_dragon": 1, "hydra": 1, "sea_serpent": 1,
    "black_frost_dragon": 1, "dread_queen": 1,
}

// ---- climate overrides (stage 3b) ------------------------------------------
// Jungle = "where ceiba/kapok grows naturally": hot + wet on flat/low terrain
// (calm/wetland geology). Dense, NO dragons. Arctic = very cold mountains:
// allows several dragons at once (incl. the special black_frost_dragon).
// Thresholds are first-pass; calibrate from real [tfg-climate] readings.
// Климатические зоны ВКЛЮЧЕНЫ (выключенными они делали джунгли обычной зоной calm).
//
// Биомы TFG описывают только РЕЛЬЕФ: все 109 tfg:earth/* из TerraFirmaGreg-Core
// уже в таблице выше, а климатических биомов вроде "джунглей" в реестре нет вовсе.
// Климат игра индексирует сама - классификацией Кёппена TFC
// (KoppenClimateClassification.classify(средняя t, осадки)), которую показывает
// строкой "Климат: ..." на экране климата. Густоту леса TFC хранит в данных чанка
// (ChunkData.getForestType). Поэтому джунгли = густой лес во влажном тёплом климате,
// на любом рельефе, кроме океана и вулканов (там свои боссы).
const ENABLE_CLIMATE_ZONES = true
const JUNGLE_CLIMATES = { TROPICAL_RAINFOREST: true, HUMID_SUBTROPICAL: true } // "Тропический лесной", "Влажный субтропический"
const JUNGLE_FORESTS = { NORMAL: true, OLD_GROWTH: true }                     // обычный и древний лес; редколесье и опушки - нет
const JUNGLE_BASES = { calm: true, wetland: true, moderate: true, karst: true }
const ARCTIC_CLIMATES = { ARCTIC: true, TUNDRA: true }                        // "Арктический", "Тундровый"

const JUNGLE = {
    level: 3, max: 10, boss: null,
    entities: ["iceandfire:myrmex_worker", "iceandfire:myrmex_soldier", "iceandfire:myrmex_swarmer",
               "iceandfire:amphithere", "iceandfire:cockatrice", "iceandfire:troll",
               "iceandfire:gorgon", "iceandfire:hippogryph", "iceandfire:stymphalian_bird", "iceandfire:ghost"],
}
const ARCTIC = {
    level: 3, max: 4, boss: "iceandfire:ice_dragon", dragonAlt: "iceandfire:black_frost_dragon", dragonCap: 2,
    entities: ["iceandfire:dread_thrall", "iceandfire:dread_ghoul", "iceandfire:dread_beast",
               "iceandfire:dread_scuttler", "iceandfire:dread_knight", "iceandfire:dread_lich",
               "iceandfire:dread_queen", "iceandfire:troll"],
}

// spawns happen only at night (>13000 daytime), to thin out the world
const NIGHT_ONLY = true

const CHECK_INTERVAL = 200   // 10s between checks

// per-zone minimum ticks between pack spawns (keyed by zone + player name)
const SPAWN_PACE_BY_ZONE = {
    calm:     12000,  // 10 min
    moderate:  9000,  // 7.5 min
    ocean:     9000,
    wetland:   4800,  // 4 min
    karst:     4800,
    desert:    4800,
    cold:      4800,
    volcanic:  2400,  // 2 min
    storm:     2400,
    jungle:    1800,  // 1.5 min
    arctic:    1800,
}
const LOADED_RADIUS = 128    // count managed mobs within this radius
const KILL_RADIUS = 128      // cleared-area radius for the kill-cooldown
const KILL_THRESHOLD = 3     // kill 3 of a type to put it on cooldown near you
const BOSS_KILL_THRESHOLD = 1
const BASE_BOSS_CHANCE = 0.12

// Real cooldown durations (ticks). 1 MC day = 24000t.
// tier1 = 10 days, tier2 = 5 days, tier3 = 1 day. Bosses x2 (applied per-kill).
const COOLDOWN_BY_TIER = { 1: 240000, 2: 120000, 3: 24000 }

function shortType(id) { return ("" + id).replace("iceandfire:", "") }

// build the set of types we manage (for kill-marker placement)
const MANAGED = {}
function _addManaged(cfg) {
    if (cfg.boss) MANAGED[shortType(cfg.boss)] = 1
    if (cfg.dragonAlt) MANAGED[shortType(cfg.dragonAlt)] = 1
    for (var _i = 0; _i < cfg.entities.length; _i++) MANAGED[shortType(cfg.entities[_i])] = 1
}
for (var _c in CATEGORIES) _addManaged(CATEGORIES[_c])
_addManaged(JUNGLE)
_addManaged(ARCTIC)

const lastSpawn = {}
const lastZone = {}   // игрок -> последняя зона, для лога смены зоны
let SERVER = null

function log(msg) { console.info("[tfg-danger-spawns] " + msg) }

function getBiomeId(lvl, pos) {
    return lvl.getBiome(pos).unwrapKey().get().location().toString()
}

// TFC climate access (confirmed working via the climate probe)
let Climate = null
try { Climate = Java.loadClass("net.dries007.tfc.util.climate.Climate") }
catch (e) { log("Climate class load FAILED: " + e) }

// Light check: block light level at a position (for spawn safety checks)
let LightLayer = null
let BlockPosClass = null
try {
    LightLayer = Java.loadClass("net.minecraft.world.level.LightLayer")
    BlockPosClass = Java.loadClass("net.minecraft.core.BlockPos")
} catch (e) { log("LightLayer/BlockPos class load FAILED: " + e) }

// Returns true if the position is lit by placed blocks (torch/lantern nearby)
function isPosLit(lvl, x, y, z) {
    if (!LightLayer || !BlockPosClass) return false
    try {
        var p = new BlockPosClass(x, y, z)
        return lvl.getBrightness(LightLayer.BLOCK, p) > 3
    } catch (e) { return false }
}

// Класс Кёппена и данные чанка TFC. ChunkData.get берём рефлексией: у него две
// двухаргументные перегрузки (BlockPos и ChunkPos), и Rhino выбрал бы наугад.
let Koppen = null
let CD_GET = null
try {
    Koppen = Java.loadClass("net.dries007.tfc.util.climate.KoppenClimateClassification")
    var _loader = Java.loadClass("net.minecraft.world.item.ItemStack").EMPTY.getClass().getClassLoader()
    CD_GET = _loader.loadClass("net.dries007.tfc.world.chunkdata.ChunkData").getMethod("get",
        _loader.loadClass("net.minecraft.world.level.LevelReader"), _loader.loadClass("net.minecraft.core.BlockPos"))
} catch (e) { log("Koppen/ChunkData load FAILED: " + e) }

// климат так, как его видит игра: класс Кёппена + тип леса в чанке
function getClimate(lvl, pos) {
    if (!Climate || !Koppen) return null
    try {
        var avgT = Climate.getAverageTemperature(lvl, pos)
        var rain = Climate.getRainfall(lvl, pos)
        var forest = "NONE"
        try { if (CD_GET) forest = String(CD_GET.invoke(null, lvl, pos).getForestType().name()) } catch (e) { }
        return { avgT: avgT, rain: rain, koppen: String(Koppen.classify(avgT, rain).name()), forest: forest }
    } catch (e) { return null }
}

// resolve the effective profile at a position, applying jungle/arctic climate
// overrides on top of the geological biome category. Returns {key, cfg, tier}.
function resolveCategory(lvl, pos) {
    var biomeId = getBiomeId(lvl, pos)
    var baseCat = BIOME_CATEGORY[biomeId]
    if (!baseCat) return null
    var info = biomeId
    if (ENABLE_CLIMATE_ZONES) {
        var clim = getClimate(lvl, pos)
        if (clim) {
            info = biomeId + ", климат " + clim.koppen + ", лес " + clim.forest +
                ", t " + Math.round(clim.avgT) + ", осадки " + Math.round(clim.rain)
            if (JUNGLE_BASES[baseCat] && JUNGLE_CLIMATES[clim.koppen] && JUNGLE_FORESTS[clim.forest])
                return { key: "jungle", cfg: JUNGLE, tier: 3, info: info }
            if ((baseCat === "cold" || baseCat === "moderate") && ARCTIC_CLIMATES[clim.koppen])
                return { key: "arctic", cfg: ARCTIC, tier: 3, info: info }
        }
    }
    return { key: baseCat, cfg: CATEGORIES[baseCat], tier: CATEGORIES[baseCat].level, info: info }
}

// count entities matching selector, evaluated AT the player's position
function countNear(server, playerName, selector) {
    return server.runCommandSilent(
        'execute as @a[name=' + playerName + '] at @s if entity ' + selector
    )
}

function packSize(entity) { return PACK_SIZES[entity] || 1 }

// ---- размещение мобов ---------------------------------------------------------
// Раньше моб появлялся на высоте ИГРОКА в 40-70 блоках от него (summon ~dx ~ ~dz):
// на склоне или из пещеры это оказывалось внутри скалы, и тварь задыхалась.
// Теперь высота берётся по карте высот в самой точке спавна, водные твари
// появляются только в воде, сухопутные - не на воде.

const IAF_SPAWN_TAG = "tfg_iaf_spawn"   // в лимит зоны идут ТОЛЬКО эти мобы
// раньше лимит считал весь tfg_managed - а его вешают ещё рейды, орды, волны,
// и бандиты рядом занимали места тварей Ice and Fire
const IAF_Heightmap = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types")
const IAF_WATER_BLOCKS = { "minecraft:water": true, "tfc:fluid/salt_water": true, "tfc:fluid/spring_water": true, "tfc:fluid/river_water": true }
const IAF_AQUATIC = { "iceandfire:siren": true, "iceandfire:hippocampus": true, "iceandfire:sea_serpent": true }
const IAF_FLYING = {
    "iceandfire:amphithere": true, "iceandfire:stymphalian_bird": true, "iceandfire:hippogryph": true,
    "iceandfire:pixie": true, "iceandfire:ghost": true, "iceandfire:fire_dragon": true,
    "iceandfire:ice_dragon": true, "iceandfire:lightning_dragon": true, "iceandfire:black_frost_dragon": true,
}

// Время суток - явным getDayTime(): обращение .dayTime отдаёт МЕТОД dayTime(), а не
// число, поэтому проверка "только ночью" молча не работала (см. tfg/zombie_hordes.js).
function iafDayTime(server, level) {
    var t = NaN
    try { t = Number(level.getDayTime()) } catch (e) { }
    if (isFinite(t)) return t
    try {
        var day = Number(server.runCommandSilent("time query day"))
        var tod = Number(server.runCommandSilent("time query daytime"))
        if (isFinite(day) && isFinite(tod)) return day * 24000 + tod
    } catch (e) { }
    return null
}

// Точка спавна вокруг (px, pz): minDist..minDist+spread по каждой оси, до 8 попыток.
function iafFindSpot(lvl, px, pz, entity, minDist, spread, ignoreLight) {
    var aquatic = IAF_AQUATIC[entity] === true
    var flying = IAF_FLYING[entity] === true
    var hm = aquatic ? IAF_Heightmap.MOTION_BLOCKING : IAF_Heightmap.MOTION_BLOCKING_NO_LEAVES
    for (var tries = 0; tries < 8; tries++) {
        var adx = minDist + Math.floor(Math.random() * spread)
        var adz = minDist + Math.floor(Math.random() * spread)
        var x = px + ((Math.random() < 0.5) ? -adx : adx)
        var z = pz + ((Math.random() < 0.5) ? -adz : adz)
        var y = Number(lvl.getHeight(hm, x, z))
        if (!isFinite(y)) continue
        var water = IAF_WATER_BLOCKS[String(lvl.getBlock(x, y - 1, z).id)] === true
        if (aquatic) {
            if (!water) continue      // сирена и прочие водные - только в воде
            y = y - 1                 // в толще воды, а не над ней
        } else if (water && !flying) {
            continue                  // сухопутных на воду не ставим
        }
        if (flying) y = y + (entity.indexOf("dragon") >= 0 ? 6 : 2)
        if (!ignoreLight && isPosLit(lvl, x, y, z)) continue  // рядом факелы/фонари
        return { x: x, y: y, z: z }
    }
    return null
}

// Суммон БЕЗ NBT: с NBT игра пропускает начальную настройку моба (finalizeSpawn),
// а у драконов Ice and Fire там выставляются пол и окрас. Теги вешаем отдельной
// командой на только что появившегося моба.
function iafSummonAt(server, playerName, entity, spot, tags) {
    var isDragon = entity.indexOf("dragon") >= 0
    var allTags = isDragon ? tags.concat(["tfg_dragon"]) : tags
    var at = "execute as @a[name=" + playerName + "] at @s positioned " + spot.x + " " + spot.y + " " + spot.z + " run "
    if (!(server.runCommandSilent(at + "summon " + entity) > 0)) return false
    var fresh = "@e[type=" + entity + ",distance=..3,limit=1,sort=nearest,tag=!" + allTags[allTags.length - 1] + "]"
    for (var i = 0; i < allTags.length; i++) server.runCommandSilent(at + "tag " + fresh + " add " + allTags[i])
    if (isDragon) {
        // взрослый дракон, стадия 3-4: 50-79 дней (EntityDragonBase.getDragonStage: 25/50/75/100)
        var days = 50 + Math.floor(Math.random() * 30)
        server.runCommandSilent(at + "data merge entity @e[type=" + entity + ",distance=..3,limit=1,sort=nearest] {AgeTicks:" + (days * 24000) + "}")
    }
    return true
}

// призвать count штук entity вокруг игрока; возвращает, сколько реально появилось
function summonPack(server, playerName, entity, count, lvl, px, pz) {
    var done = 0
    for (var i = 0; i < count; i++) {
        var spot = iafFindSpot(lvl, px, pz, entity, 40, 30, false)
        if (!spot) continue
        if (iafSummonAt(server, playerName, entity, spot, ["tfg_managed", IAF_SPAWN_TAG])) done++
    }
    return done
}

// ---- kill markers ----------------------------------------------------------
function deathHandler(event) {
    try {
        var ent = event.entity
        var typeId = "" + ent.type
        if (typeId.indexOf("iceandfire") < 0) return
        var sh = shortType(typeId)
        if (!MANAGED[sh]) return
        if (!SERVER) return

        var x = ent.blockX, y = ent.blockY, z = ent.blockZ
        var tier = 1
        try {
            var rc = resolveCategory(ent.level, ent.blockPosition)
            if (rc) tier = rc.tier
        } catch (e) {}
        var dur = COOLDOWN_BY_TIER[tier]
        if (BOSS_SET[sh]) dur = dur * 2

        var cmd = 'summon minecraft:area_effect_cloud ' + x + ' ' + y + ' ' + z +
                  ' {Duration:' + dur + ',Radius:0f,WaitTime:0,Tags:["tfg_kill_' + sh + '"]}'
        var res = SERVER.runCommandSilent(cmd)
        log("kill marker: " + sh + " tier" + tier + " dur" + dur + "t -> " + res)
    } catch (e) {
        log("death handler crashed: " + e)
    }
}

try {
    EntityEvents.death(deathHandler)
} catch (e) {
    log("register EntityEvents.death FAILED: " + e)
}

// ---- main spawn loop -------------------------------------------------------
ServerEvents.tick(event => {
    if (!SERVER) SERVER = event.server
    if (event.server.tickCount % CHECK_INTERVAL !== 0) return

    event.server.players.forEach(player => {
        try {
            var playerLevel = player.level
            var pos = player.blockPosition
            var rc = resolveCategory(playerLevel, pos)
            if (!rc) return
            var cfg = rc.cfg
            var zone = rc.key
            var name = player.username
            if (lastZone[name] !== zone) {
                lastZone[name] = zone
                log(name + ": зона " + zone + " (" + rc.info + ")")
            }
            var now = event.server.tickCount
            var server = event.server
            var lastKey = name + "|" + zone

            // pace per player per zone
            var zonePace = SPAWN_PACE_BY_ZONE[zone] || 6000
            if ((now - (lastSpawn[lastKey] || 0)) < zonePace) return

            // night-only: day ticks 0-12999 = day, 13000+ = night
            var dayTime = iafDayTime(server, playerLevel)
            if (NIGHT_ONLY && (dayTime === null || (dayTime % 24000) < 13000)) return

            // ward protection: skip if player is in a passive ward zone or has personal ward active
            if (server.runCommandSilent('execute if entity @a[name=' + name + ',tag=tfg_warded]') > 0) return

            // bed safety zone: no spawns within 80 blocks of player's respawn point
            var bedPos = player.respawnPosition
            if (bedPos) {
                var _bx = player.blockX - bedPos.x
                var _bz = player.blockZ - bedPos.z
                if (_bx * _bx + _bz * _bz < 6400) return  // 80^2 = 6400
            }

            // loaded cap
            var loaded = countNear(server, name, '@e[tag=' + IAF_SPAWN_TAG + ',distance=..' + LOADED_RADIUS + ']')
            if (loaded >= cfg.max) {
                log(name + ": at cap (" + loaded + "/" + cfg.max + ") in " + zone)
                return
            }
            var slots = cfg.max - loaded

            if (zone === "arctic") {
                // arctic: several dragons allowed at once (incl. black_frost_dragon)
                var dragons = countNear(server, name, '@e[tag=tfg_dragon,distance=..' + LOADED_RADIUS + ']')
                if (dragons < cfg.dragonCap && Math.random() < 0.2) {
                    var dragon = (Math.random() < 0.5) ? cfg.boss : cfg.dragonAlt
                    var dcd = countNear(server, name, '@e[tag=tfg_kill_' + shortType(dragon) + ',distance=..' + KILL_RADIUS + ']')
                    if (dcd < BOSS_KILL_THRESHOLD) {
                        summonPack(server, name, dragon, 1, playerLevel, player.blockX, player.blockZ)
                        lastSpawn[lastKey] = now
                        log(name + ": ARCTIC dragon " + dragon + " (" + (dragons + 1) + "/" + cfg.dragonCap + ")")
                        return
                    }
                }
            } else if (cfg.boss) {
                // normal single boss (solitary, own cooldown). ocean tier1 has a boss.
                var bossChance = BASE_BOSS_CHANCE
                if (zone === "storm" && playerLevel.isThundering()) bossChance = 0.4
                if (zone === "cold" && playerLevel.isRaining()) bossChance = 0.35
                if (zone === "volcanic" && dayTime !== null && (dayTime % 24000) > 13000) bossChance = 0.25
                if (Math.random() < bossChance) {
                    var bsh = shortType(cfg.boss)
                    var bcd = countNear(server, name, '@e[tag=tfg_kill_' + bsh + ',distance=..' + KILL_RADIUS + ']')
                    if (bcd < BOSS_KILL_THRESHOLD) {
                        summonPack(server, name, cfg.boss, 1, playerLevel, player.blockX, player.blockZ)
                        lastSpawn[lastKey] = now
                        log(name + ": BOSS " + cfg.boss + " in " + zone)
                        return
                    }
                }
            }

            // normal: pick from types not on cooldown
            var available = []
            for (var i = 0; i < cfg.entities.length; i++) {
                var e = cfg.entities[i]
                var kc = countNear(server, name, '@e[tag=tfg_kill_' + shortType(e) + ',distance=..' + KILL_RADIUS + ']')
                if (kc > 0) log(name + ": " + shortType(e) + " killcount=" + kc + "/" + KILL_THRESHOLD + " in " + zone)
                if (kc < KILL_THRESHOLD) available.push(e)
            }
            if (available.length === 0) {
                log(name + ": all types on cooldown in " + zone)
                return
            }

            var entity = available[Math.floor(Math.random() * available.length)]
            var pack = Math.min(packSize(entity), slots)
            // тролли: предиката tfg:dark_enough в паке нет, с ним они не спавнились вовсе;
            // темнота теперь = ночь (NIGHT_ONLY) + нет факелов у точки спавна
            var spawned = summonPack(server, name, entity, pack, playerLevel, player.blockX, player.blockZ)
            lastSpawn[lastKey] = now
            log(name + ": pack " + entity + " x" + spawned + "/" + pack + " in " + zone + " (loaded " + loaded + "/" + cfg.max + ")")
        } catch (e) {
            log("ERROR for " + player.username + ": " + e)
        }
    })
})
