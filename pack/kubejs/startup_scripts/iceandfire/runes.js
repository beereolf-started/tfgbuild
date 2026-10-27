// Rune micro-mod — item and block registration.
// REQUIRES full server restart after first deploy.

StartupEvents.registry('item', event => {
    var runes = [
        { id: 'tfg:rune_ward_1',      label: 'Руна Оберега I',     glow: true  },
        { id: 'tfg:rune_ward_2',      label: 'Руна Оберега II',    glow: true  },
        { id: 'tfg:rune_ward_3',      label: 'Руна Оберега III',   glow: true  },
        { id: 'tfg:rune_forecast',    label: 'Руна Прогноза',      glow: false },
        { id: 'tfg:rune_wave_summon', label: 'Руна Призыва Волны', glow: false },
    ]
    runes.forEach(function(r) {
        var short = r.id.replace('tfg:', '')
        var item = event.create(r.id)
            .displayName(r.label)
            .texture('tfg:item/rune/' + short.replace('rune_', ''))
            .maxStackSize(8)
            .tag('tfg:runes')
        if (r.glow) item.glow(true)
    })
})

StartupEvents.registry('block', event => {
    var runeBlocks = [
        { id: 'tfg:rune_block_ward_1',      tex: 'ward_1',      light: 4  },
        { id: 'tfg:rune_block_ward_2',      tex: 'ward_2',      light: 6  },
        { id: 'tfg:rune_block_ward_3',      tex: 'ward_3',      light: 10 },
        { id: 'tfg:rune_block_forecast',    tex: 'forecast',    light: 5  },
        { id: 'tfg:rune_block_wave_summon', tex: 'wave_summon', light: 7  },
    ]
    runeBlocks.forEach(function(b) {
        event.create(b.id)
            .textureAll('tfg:block/rune/' + b.tex)
            .hardness(1.5)
            .resistance(6.0)
            .soundType('stone')
            .lightLevel(b.light)
            .tagBlock('minecraft:mineable/pickaxe')
            .requiresTool(false)
            .noDrops()  // drops handled by loot table JSONs
    })
})
