// Auto-place named players at a custom default spawn on their FIRST join.
// Fires once per player (persistentData flag tfg_placed_v2).
// For kvassdwarf: finds nearest mountains biome near the search origin,
// samples a grid to compute the centroid, then teleports to surface there.

let PS_SERVER = null
ServerEvents.tick(e => { if (!PS_SERVER) PS_SERVER = e.server })

// Search origin for kvassdwarf (player-requested area)
const KVASSDWARF_SEARCH_X = -101543
const KVASSDWARF_SEARCH_Z = -31415

// Mountain biome IDs (moderate tier from BIOME_CATEGORY in danger_spawns.js)
const MOUNTAIN_BIOME_IDS = [
    "tfg:earth/mountains",         "tfg:earth/old_mountains",
    "tfg:earth/highlands",         "tfg:earth/rocky_plateau",
    "tfg:earth/mountain_lake",     "tfg:earth/old_mountain_lake",
    "tfg:earth/oceanic_mountains", "tfg:earth/oceanic_mountain_lake",
]

function isMountainBiome(id) {
    for (var _i = 0; _i < MOUNTAIN_BIOME_IDS.length; _i++) {
        if (id === MOUNTAIN_BIOME_IDS[_i]) return true
    }
    return false
}

// Find nearest mountain biome, then scan a grid around it to find the centroid.
// Returns {x, z} or null on failure.
function findMountainCenter(lvl, cx, cz) {
    try {
        var BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        var origin = new BlockPos(cx, 100, cz)

        // Step 1: locate nearest mountain biome block
        var found = lvl.findClosestBiome3d(
            function(holder) {
                try { return isMountainBiome(holder.unwrapKey().get().location().toString()) }
                catch (_e) { return false }
            },
            origin, 6400, 32, 64, lvl.random
        )
        if (!found || !found.isPresent()) {
            console.info('[tfg-spawn] no mountain biome found within 6400 blocks of search origin')
            return null
        }

        var seed = found.get().getFirst()
        var sx = seed.getX(), sz = seed.getZ()
        console.info('[tfg-spawn] mountain seed at ' + sx + ',' + sz)

        // Step 2: grid-sample around seed to find biome centroid
        var sumX = sx, sumZ = sz, count = 1
        var SCAN_RADIUS = 1024, SCAN_STEP = 128
        for (var dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx += SCAN_STEP) {
            for (var dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz += SCAN_STEP) {
                try {
                    var p = new BlockPos(sx + dx, 100, sz + dz)
                    var bid = lvl.getBiome(p).unwrapKey().get().location().toString()
                    if (isMountainBiome(bid)) {
                        sumX += (sx + dx)
                        sumZ += (sz + dz)
                        count++
                    }
                } catch (_e2) {}
            }
        }

        var rx = Math.floor(sumX / count)
        var rz = Math.floor(sumZ / count)
        console.info('[tfg-spawn] mountain centroid at ' + rx + ',' + rz + ' (' + count + ' samples)')
        return { x: rx, z: rz }
    } catch (e) {
        console.info('[tfg-spawn] findMountainCenter error: ' + e)
        return null
    }
}

// Get surface block Y at (x, z). Falls back to 100 on error.
function getSurfaceY(lvl, x, z) {
    try {
        var HeightTypes = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types")
        return lvl.getHeight(HeightTypes.WORLD_SURFACE, x, z)
    } catch (e) {
        console.info('[tfg-spawn] getSurfaceY error: ' + e)
        return 100
    }
}

function onLogin(event) {
    try {
        var player = event.player
        if (player.username.toLowerCase() !== "kvassdwarf") return
        if (player.persistentData.getBoolean("tfg_placed_v2")) return
        if (!PS_SERVER) return

        var name = player.username
        PS_SERVER.scheduleInTicks(20, function() {
            try {
                var lvl = player.level
                var center = findMountainCenter(lvl, KVASSDWARF_SEARCH_X, KVASSDWARF_SEARCH_Z)
                var tx, tz, ty
                if (center) {
                    tx = center.x
                    tz = center.z
                } else {
                    // fallback: use raw search origin if locate failed
                    tx = KVASSDWARF_SEARCH_X
                    tz = KVASSDWARF_SEARCH_Z
                }
                ty = getSurfaceY(lvl, tx, tz) + 1

                PS_SERVER.runCommandSilent('spawnpoint ' + name + ' ' + tx + ' ' + ty + ' ' + tz)
                PS_SERVER.runCommandSilent('execute in minecraft:overworld run tp ' + name + ' ' + tx + ' ' + ty + ' ' + tz)
                player.persistentData.putBoolean("tfg_placed_v2", true)
                console.info('[tfg-spawn] placed ' + name + ' at mountain ' + tx + ',' + ty + ',' + tz)
            } catch (err) {
                console.info('[tfg-spawn] placement FAILED: ' + err)
            }
        })
    } catch (e) {
        console.info('[tfg-spawn] onLogin error: ' + e)
    }
}

try {
    PlayerEvents.loggedIn(onLogin)
    console.info('[tfg-spawn] loaded (loggedIn registered)')
} catch (e) {
    console.info('[tfg-spawn] loggedIn registration FAILED: ' + e)
}
