// Rune micro-mod — server-side behavior and recipes.
// Reload: /kubejs reload server_scripts

var RSERVER = null

// item id → block id (for stone-engraving)
var RUNE_TO_BLOCK = {
    'tfg:rune_ward_1':      'tfg:rune_block_ward_1',
    'tfg:rune_ward_2':      'tfg:rune_block_ward_2',
    'tfg:rune_ward_3':      'tfg:rune_block_ward_3',
    'tfg:rune_forecast':    'tfg:rune_block_forecast',
    'tfg:rune_wave_summon': 'tfg:rune_block_wave_summon',
}
// block id → item id
var BLOCK_TO_RUNE = {}
for (var _k in RUNE_TO_BLOCK) BLOCK_TO_RUNE[RUNE_TO_BLOCK[_k]] = _k

// ward tier → armor-stand tag + protection radius
var WARD_ANCHOR_TAG = {
    'tfg:rune_block_ward_1': 'tfg_wa_100',
    'tfg:rune_block_ward_2': 'tfg_wa_200',
    'tfg:rune_block_ward_3': 'tfg_wa_500',
}
var WARD_RADIUS = {
    'tfg:rune_block_ward_1': 100,
    'tfg:rune_block_ward_2': 200,
    'tfg:rune_block_ward_3': 500,
}
// personal activation duration (ticks): tier1=5min, tier2=10min, tier3=20min
var WARD_PERSONAL_TICKS = {
    'tfg:rune_block_ward_1': 6000,
    'tfg:rune_block_ward_2': 12000,
    'tfg:rune_block_ward_3': 24000,
}

// TFC raw stone prefixes + vanilla smooth stone IDs (NOT cobblestone)
var STONE_PREFIXES = ['tfc:rock/raw/', 'tfc:rock/hardened/']
var STONE_VANILLA  = [
    'minecraft:stone', 'minecraft:granite', 'minecraft:polished_granite',
    'minecraft:diorite', 'minecraft:polished_diorite',
    'minecraft:andesite', 'minecraft:polished_andesite',
    'minecraft:deepslate', 'minecraft:polished_deepslate',
    'minecraft:calcite', 'minecraft:tuff',
]

function isStoneBlock(id) {
    var sid = '' + id
    for (var pi = 0; pi < STONE_PREFIXES.length; pi++) {
        if (sid.startsWith(STONE_PREFIXES[pi])) return true
    }
    for (var vi = 0; vi < STONE_VANILLA.length; vi++) {
        if (sid === STONE_VANILLA[vi]) return true
    }
    return false
}

// Wave schedule helper (mirrors wave_spawns.js)
var W_DAY = 24000
function nextWaveTick(fired, origin) {
    if (fired === 0) return origin + 30 * W_DAY
    if (fired === 1) return origin + 180 * W_DAY
    return origin + (fired - 1) * 360 * W_DAY
}
function waveSize(fired) {
    if (fired === 0) return 5
    if (fired === 1) return 10
    return 20
}

// ── CAPTURE SERVER ────────────────────────────────────────────────────────────
ServerEvents.tick(function(event) {
    if (!RSERVER) RSERVER = event.server
})

// ── ENGRAVING: right-click ANY stone with a rune item → stamp rune block ──────
BlockEvents.rightClicked(function(event) {
    var heldId  = event.player.mainHandItem.id
    var blockId = '' + event.block.id
    if (!RUNE_TO_BLOCK[heldId]) return        // not a rune item
    if (!isStoneBlock(blockId)) return        // not an engraveable stone
    if (event.player.isCrouching()) return    // sneak = skip

    var pos        = event.pos
    var x = pos.x, y = pos.y, z = pos.z
    var targetBlock = RUNE_TO_BLOCK[heldId]
    var srv = event.server

    // replace stone with rune block
    srv.runCommandSilent('setblock ' + x + ' ' + y + ' ' + z + ' ' + targetBlock)
    event.player.mainHandItem.shrink(1)

    // for ward blocks: plant an invisible anchor armor stand at the block
    if (WARD_ANCHOR_TAG[targetBlock]) {
        var wtag = WARD_ANCHOR_TAG[targetBlock]
        srv.runCommandSilent(
            'summon minecraft:armor_stand ' + x + ' ' + y + ' ' + z +
            ' {Invisible:1b,NoGravity:1b,Marker:1b,Small:1b,' +
            'Tags:["tfg_ward_anchor","' + wtag + '"]}'
        )
    }

    srv.runCommandSilent(
        'tellraw @a[name=' + event.player.username + '] ' +
        '{"text":"[Руна] Знак вырезан в камне.","color":"gray","italic":true}'
    )
    event.cancel()
})

// ── ACTIVATION: right-click the placed rune block → effect ───────────────────
BlockEvents.rightClicked(function(event) {
    var blockId = '' + event.block.id
    if (!BLOCK_TO_RUNE[blockId]) return       // not a rune block
    if (event.player.isCrouching()) return

    var player = event.player
    var name   = player.username
    var srv    = event.server
    var pos    = event.pos
    var now    = srv.tickCount

    // ── WARD runes ──────────────────────────────────────────────────
    if (WARD_RADIUS[blockId]) {
        var radius   = WARD_RADIUS[blockId]
        var duration = WARD_PERSONAL_TICKS[blockId]   // tier-specific ticks
        var endTick  = now + duration
        var mins     = Math.floor(duration / 1200)    // 1200 ticks = 1 min
        player.persistentData.putLong('tfg_ward_personal_end', endTick)
        srv.runCommandSilent('title @a[name=' + name + '] times 5 70 15')
        srv.runCommandSilent(
            'title @a[name=' + name + '] subtitle ' +
            '{"text":"Личная защита ' + mins + ' мин. • Зона ' + radius + ' бл.","color":"aqua"}'
        )
        srv.runCommandSilent(
            'title @a[name=' + name + '] title ' +
            '{"text":"Оберег активирован","color":"light_purple","bold":true}'
        )
        srv.runCommandSilent(
            'tellraw @a[name=' + name + '] [' +
            '{"text":"[Оберег] ","color":"light_purple"},' +
            '{"text":"Постоянная зона заморозки: ' + radius + ' бл. • ","color":"gray"},' +
            '{"text":"Личная защита: ' + mins + ' мин.","color":"aqua"}]'
        )
        event.cancel()
        return
    }

    // ── FORECAST rune ──────────────────────────────────────────────
    if (blockId === 'tfg:rune_block_forecast') {
        var pd = player.persistentData
        if (!pd.contains('tfg_wave_origin')) {
            srv.runCommandSilent(
                'tellraw @a[name=' + name + '] ' +
                '{"text":"[Прогноз] Нет данных о волне. Войдите в игру, чтобы запустить отсчёт.","color":"yellow"}'
            )
            event.cancel()
            return
        }
        var gameTime = Number(player.level.gameTime) // см. правку в wave_spawns.js - .getGameTime() падает
        var origin   = Number(pd.getLong('tfg_wave_origin'))
        var fired    = pd.getInt('tfg_wave_count')
        var nextT    = nextWaveTick(fired, origin)
        var daysLeft = Math.ceil((nextT - gameTime) / W_DAY)
        var size     = waveSize(fired)

        if (daysLeft <= 0) {
            srv.runCommandSilent(
                'tellraw @a[name=' + name + '] ' +
                '{"text":"[Прогноз] Волна уже должна была прийти!","color":"dark_red","bold":true}'
            )
        } else {
            srv.runCommandSilent(
                'tellraw @a[name=' + name + '] [' +
                '{"text":"[Прогноз] ","color":"yellow"},' +
                '{"text":"До следующей волны: ","color":"white"},' +
                '{"text":"' + daysLeft + ' дн. ","color":"gold","bold":true},' +
                '{"text":"• Размер: ' + size + ' существ","color":"gray"}]'
            )
        }
        event.cancel()
        return
    }

    // ── WAVE SUMMON rune (одноразовая) ─────────────────────────────
    if (blockId === 'tfg:rune_block_wave_summon') {
        var pd2      = player.persistentData
        var gtime2   = Number(player.level.gameTime)
        var fired2   = pd2.getInt('tfg_wave_count')
        // shift origin so next wave fires immediately on next wave_spawns tick
        var newOrigin
        if (fired2 === 0)      newOrigin = gtime2 - 30  * W_DAY
        else if (fired2 === 1) newOrigin = gtime2 - 180 * W_DAY
        else                   newOrigin = gtime2 - (fired2 - 1) * 360 * W_DAY
        pd2.putLong('tfg_wave_origin', newOrigin)

        // destroy block (single-use rune)
        srv.runCommandSilent('setblock ' + pos.x + ' ' + pos.y + ' ' + pos.z + ' minecraft:air')
        srv.runCommandSilent('title @a[name=' + name + '] times 5 100 20')
        srv.runCommandSilent(
            'title @a[name=' + name + '] subtitle ' +
            '{"text":"Волна на подходе...","color":"dark_red"}'
        )
        srv.runCommandSilent(
            'title @a[name=' + name + '] title ' +
            '{"text":"ПРИЗЫВ ВОЛНЫ","color":"dark_red","bold":true}'
        )
        srv.runCommandSilent(
            'tellraw @a[name=' + name + '] ' +
            '{"text":"[Призыв] Ты разбудил нечто. Руна распалась.","color":"dark_red","bold":true}'
        )
        event.cancel()
        return
    }
})

// ── BLOCK BREAK: kill ward anchor at that position ────────────────────────────
BlockEvents.broken(function(event) {
    var blockId = '' + event.block.id
    if (!WARD_ANCHOR_TAG[blockId]) return
    var pos = event.pos
    // kill the anchor armor stand sitting at exactly this block
    event.server.runCommandSilent(
        'execute positioned ' + pos.x + '.5 ' + pos.y + '.5 ' + pos.z + '.5 ' +
        'run kill @e[tag=tfg_ward_anchor,distance=..1]'
    )
})

// ── WARD TICK ─────────────────────────────────────────────────────────────────
// Runs every 100 ticks (5 sec).
// PASSIVE layer  — permanent while block + anchor exist: freeze mobs near anchors.
// PERSONAL layer — timed per right-click: suppress spawns for the activating player.
//
// tfg_warded tag = spawn suppression (used by danger_spawns.js)
//   set when player is inside a passive ward zone OR has an active personal timer
ServerEvents.tick(function(event) {
    if (!RSERVER) return
    if (event.server.tickCount % 100 !== 0) return   // every 5 seconds

    var now3 = event.server.tickCount

    // 1. Clear tfg_warded from everyone — will be re-added below
    RSERVER.runCommandSilent('tag @a[tag=tfg_warded] remove tfg_warded')

    // 2. PASSIVE: re-tag players standing inside any ward zone
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_100] at @s as @a[distance=..100] run tag @s add tfg_warded')
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_200] at @s as @a[distance=..200] run tag @s add tfg_warded')
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_500] at @s as @a[distance=..500] run tag @s add tfg_warded')

    // 3. PERSONAL: check each player's personal protection timer
    event.server.players.forEach(function(player) {
        var pd    = player.persistentData
        var name3 = player.username
        if (!pd.contains('tfg_ward_personal_end')) return
        var endT = Number(pd.getLong('tfg_ward_personal_end'))
        if (now3 <= endT) {
            // still active — tag the player (may already be tagged from passive zone)
            RSERVER.runCommandSilent('tag @a[name=' + name3 + '] add tfg_warded')
        } else {
            // expired — clean up and notify
            pd.remove('tfg_ward_personal_end')
            player.sendMessage('§7[Оберег] Личная защита рассеялась.')
        }
    })

    // 4. PASSIVE freeze: NoAI on managed I&F mobs inside any anchor zone
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_100] at @s as @e[tag=tfg_managed,distance=..100] run data merge entity @s {NoAI:1b}')
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_200] at @s as @e[tag=tfg_managed,distance=..200] run data merge entity @s {NoAI:1b}')
    RSERVER.runCommandSilent('execute as @e[tag=tfg_wa_500] at @s as @e[tag=tfg_managed,distance=..500] run data merge entity @s {NoAI:1b}')

    // 5. Restore AI for frozen mobs outside ALL ward zones
    RSERVER.runCommandSilent(
        'execute as @e[tag=tfg_managed,nbt={NoAI:1b}] at @s ' +
        'unless entity @e[tag=tfg_wa_100,distance=..100] ' +
        'unless entity @e[tag=tfg_wa_200,distance=..200] ' +
        'unless entity @e[tag=tfg_wa_500,distance=..500] ' +
        'run data merge entity @s {NoAI:0b}'
    )
})

// ── RECIPES ───────────────────────────────────────────────────────────────────
ServerEvents.recipes(function(event) {

    // Руна Оберега I — ghost_ingot + cyclops_eye + pixie_dust + light_blue_dye
    event.shaped('tfg:rune_ward_1', [
        'D G D',
        'G E G',
        'D P D'
    ], {
        D: 'minecraft:light_blue_dye',
        G: 'iceandfire:ghost_ingot',
        E: 'iceandfire:cyclops_eye',
        P: 'iceandfire:pixie_dust'
    })

    // Руна Оберега II — upgrade I + siren_tear + troll_tusk + blue_dye
    event.shaped('tfg:rune_ward_2', [
        'D T D',
        'S W S',
        'D L D'
    ], {
        D: 'minecraft:blue_dye',
        T: 'iceandfire:troll_tusk',
        S: 'iceandfire:siren_tear',
        W: 'tfg:rune_ward_1',
        L: 'iceandfire:troll_leather_forest'
    })

    // Руна Оберега III — upgrade II + hydra parts + dragonscales + purple_dye
    event.shaped('tfg:rune_ward_3', [
        'D F D',
        'H W H',
        'D R D'
    ], {
        D: 'minecraft:purple_dye',
        F: 'iceandfire:hydra_fang',
        H: 'iceandfire:hydra_heart',
        W: 'tfg:rune_ward_2',
        R: 'iceandfire:dragonscales_red'
    })

    // Руна Прогноза — pixie_wings + ectoplasm + dread_shard + yellow_dye
    event.shaped('tfg:rune_forecast', [
        'D W D',
        'E S E',
        'D P D'
    ], {
        D: 'minecraft:yellow_dye',
        W: 'iceandfire:pixie_wings',
        E: 'iceandfire:ectoplasm',
        S: 'iceandfire:dread_shard',
        P: 'iceandfire:pixie_dust'
    })

    // Руна Призыва Волны — dread_key + dread_shard + dragonscales_red + red_dye
    event.shaped('tfg:rune_wave_summon', [
        'D K D',
        'S R S',
        'D S D'
    ], {
        D: 'minecraft:red_dye',
        K: 'iceandfire:dread_key',
        S: 'iceandfire:dread_shard',
        R: 'iceandfire:dragonscales_red'
    })
})
