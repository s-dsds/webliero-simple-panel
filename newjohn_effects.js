/**
 * newjohn plugin — effects library. Ported from the buildinggame implementation
 * (buildinggame/c_effects.js + _material_init.js), which already fixed the
 * newjohn/effects.js freeze class (3000px caps on the main growers, indexed
 * writes instead of O(n²) reduce(concat), corrected stretch/bigger row math).
 *
 * NO LONGER VERBATIM — executable fuzzing of the bundle found latent defects in
 * buildinggame itself, fixed HERE and marked "PORT FIX" inline (upstream still
 * carries them):
 *   - bottom/right: OOB reads → undefined holes on odd dims (17% of random
 *     5-chains!) — now keep the LAST N rows/cols, valid for every N.
 *   - expand/double/expandrev/expandalt: primary copy was uncapped (the
 *     source's own "//not good"), len != w*h for inputs ≥3000 wide — now a
 *     uniform outW=min(2w,cap) shape, behavior-identical below the cap.
 *   - addbg: per-side clamp didn't bound the SUM of opposite sides (2x cap
 *     possible) — second side of each axis now clamps the total.
 * Top-level decls are `var` (not const) so a hot-reload of this file alone
 * doesn't throw "Identifier already declared".
 * If you fix buildinggame upstream, port its changes here manually and keep the
 * PORT FIX blocks.
 *
 * Globals introduced (verified collision-free in this bundle): MATERIAL,
 * MAT_GROUP, defaultMaterials, MatString, isColorIdxMatString, randomBG,
 * GreyRock, randomGreyRock, randomColor, BrownDirt, randomBrownDirt,
 * maxMaxWidthHeight, effects, effectList.
 */

var MATERIAL = {
    UNDEF: 0,
    DIRT: 1,
    DIRT_2: 2,    
    ROCK: 4,
    BG: 8,
    BG_DIRT: 9,
    BG_DIRT_2: 10,
    BG_SEESHADOW: 24,
    WORM: 32,
}

var MAT_GROUP = {
    bg: [MATERIAL.BG,MATERIAL.BG_DIRT,MATERIAL.BG_DIRT_2, MATERIAL.BG_SEESHADOW],
    rock: [MATERIAL.ROCK],
    undef: [MATERIAL.UNDEF, MATERIAL.WORM],
    dirt: [MATERIAL.DIRT_2, MATERIAL.DIRT],
}

var defaultMaterials = [0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 32, 32, 32, 32, 32, 32, 32, 32, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 0, 0, 1, 1, 1, 4, 4, 4, 1, 1, 1, 4, 4, 4, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 4, 4, 4, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 24, 24, 8, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
];

var randomBG = () => [160,161,162,163][Math.round(Math.random()*3)]
var GreyRock = [...Array.from(Array(11).keys()).map((x)=>x+19)];
var randomGreyRock = () => GreyRock[Math.round(Math.random()*10)]
var randomColor = () => Math.round(Math.random()*255)
var BrownDirt = [...Array.from(Array(7).keys()).map((x)=>x+12)];
var randomBrownDirt = () => BrownDirt[Math.round(Math.random()*6)]
var MatString = {
    rock: [MATERIAL.ROCK],
    undef: [MATERIAL.UNDEF, MATERIAL.WORM],
    dirt: [MATERIAL.DIRT, MATERIAL.DIRT_2],
    bg: [MATERIAL.BG, MATERIAL.BG_DIRT, MATERIAL.BG_DIRT, MATERIAL.BG_SEESHADOW],
}

var isColorIdxMatString = (idx, str) => {
    try {
        return MatString[str].includes(defaultMaterials[idx])
    } catch(e) { }
    return false
}
var maxMaxWidthHeight = 3000
var effects = {
    stretch: function (map) /* stretches map horizontally, will cut if more than 3000pix wide */ {
        let ret = [];      
        const maxedOutWidth=map.width*2>maxMaxWidthHeight?Math.round(maxMaxWidthHeight/2):map.width
        
        for (let j = 0; j < map.height; j++ ) {
            for (let i = 0; i<maxedOutWidth; i++) {
                ret.push(map.data[(j*map.width)+i]);
                ret.push(map.data[(j*map.width)+i]);
            }
        } 

        return { 
            name: map.name,
            width:maxedOutWidth*2,
            height:map.height,
            data:ret
        }
    },
    stretchy: function (map)  /* stretches map vertically, will cut if more than 3000pix high */ {
        let ret = [];    
        const maxedOutHeight=map.height*2>maxMaxWidthHeight?Math.round(maxMaxWidthHeight/2):map.height            
        for (let j = 0; j < maxedOutHeight; j++ ) {
            for (let i = 0; i<map.width; i++) {
                let currpix =map.data[(j*map.width)+i];
                ret[(j*2*map.width)+i] = currpix
                ret[(((j*2)+1)*map.width)+i] = currpix
            }            
        }
  
        return { 
            name: map.name,
            width:map.width,
            height:maxedOutHeight*2,
            data:ret
        }
    },
    rotate: function (map) /* rotate maps clockwise */ {
        let ret = [];

        for (let j =0; j<map.width; j++) {
            for (let i=map.height-1; i>=0; i--) {        
                ret.push(map.data[ (map.width*i)+  j]);
            }
        }
         
        return {
            name: map.name, 
            width:map.height,
            height:map.width,
            data:ret
        }
    },
    bigger: function(map) /* (1 pixel = 4 pixels) | will cut anything above 3000 pixels*/ {
        let ret = [];        
        let newMaxedOutWidth = (map.width*2)>maxMaxWidthHeight?maxMaxWidthHeight:(map.width*2)
        let newMaxedOutHeight = (map.height*2)>maxMaxWidthHeight?maxMaxWidthHeight:(map.height*2)  
        for (let j = 0; j < newMaxedOutHeight; j+=2) {
            let currY = (j==0?j:j/2)
            for (let i = 0; i<newMaxedOutWidth; i+=2) {
                let currpix =map.data[(currY*map.width)+(i==0?i:i/2)];
                
                ret[(j*newMaxedOutWidth)+i] = currpix
                ret[((j+1)*newMaxedOutWidth)+i] = currpix
                
                ret[(j*newMaxedOutWidth)+i+1] = currpix
                ret[((j+1)*newMaxedOutWidth)+i+1] = currpix
            }            
        }
  
        return { 
            name: map.name,
            width:newMaxedOutWidth,
            height:newMaxedOutHeight,
            data:ret
        }
    },
    reverse: function (map) /* reverse map vertically */ {
        let ret = [];
        const ln =  (map.width*map.height)-1;
        for (let i = ln; i >= 0; i--) {
            ret.push(map.data[i]);
        }
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    mirror: function (map) /* mirrors map horizontally */ {
        let ret = [];
        for (let j = 0; j < map.height; j++ ) {
            for (let i = map.width-1; i >= 0; i--) {
                
                    ret.push(map.data[(j*map.width)+i]);
                        
            }
        }  
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },        
    /* PORT FIX (expand family, diverges from buildinggame): the source's
     * primary-copy loop was uncapped (its own "//not good" comment), so a
     * source width >= the 3000 cap produced data.length != declared width*height
     * (the mappool hook then silently dropped the transform). This uniform
     * shape — outW = min(2w, cap), full original up to outW, second copy fills
     * exactly the remainder — is behavior-identical for w < cap and length-
     * consistent for every input. Only the second-copy pixel source differs
     * between the four variants. */
    expand: function (map) /* expands with a mirrored version */ {
        let ret = [];
        const outW = Math.min(map.width*2, maxMaxWidthHeight);
        const firstW = Math.min(map.width, outW);
        const restW = outW - firstW;
        for (let j = 0; j < map.height; j++ ) {
            const row = j*map.width;
            for (let i = 0; i<firstW; i++) {
                ret.push(map.data[row+i]);
            }
            for (let k = 0; k<restW; k++) { // mirrored: descending from column restW-1
                ret.push(map.data[row+(restW-1-k)]);
            }
        }
        return {
            name: map.name,
            width:outW,
            height:map.height,
            data:ret
        }
    },
    double: function (map) /* copies the map to the right */  {
        let ret = [];
        const outW = Math.min(map.width*2, maxMaxWidthHeight);
        const firstW = Math.min(map.width, outW);
        const restW = outW - firstW;
        for (let j = 0; j < map.height; j++ ) {
            const row = j*map.width;
            for (let i = 0; i<firstW; i++) {
                ret.push(map.data[row+i]);
            }
            for (let k = 0; k<restW; k++) { // copy: ascending from column 0
                ret.push(map.data[row+k]);
            }
        }
        return {
            name: map.name,
            width:outW,
            height:map.height,
            data:ret
        }
    },
    expandrev: function (map) /* expands with a reversed version */ {
        let ret = [];
        const outW = Math.min(map.width*2, maxMaxWidthHeight);
        const firstW = Math.min(map.width, outW);
        const restW = outW - firstW;
        for (let j = 0; j < map.height; j++ ) {
            const row = j*map.width;
            const revrow = (map.height-j-1)*map.width;
            for (let i = 0; i<firstW; i++) {
                ret.push(map.data[row+i]);
            }
            for (let k = 0; k<restW; k++) { // vertically reversed: ascending
                ret.push(map.data[revrow+k]);
            }
        }
        return {
            name: map.name,
            width:outW,
            height:map.height,
            data:ret
        }
    },
    expandalt: function (map) /* expands with a reversed & mirrored version */ {
        let ret = [];
        const outW = Math.min(map.width*2, maxMaxWidthHeight);
        const firstW = Math.min(map.width, outW);
        const restW = outW - firstW;
        for (let j = 0; j < map.height; j++ ) {
            const row = j*map.width;
            const revrow = (map.height-j-1)*map.width;
            for (let i = 0; i<firstW; i++) {
                ret.push(map.data[row+i]);
            }
            for (let k = 0; k<restW; k++) { // reversed + mirrored: descending
                ret.push(map.data[revrow+(restW-1-k)]);
            }
        }
        return {
            name: map.name,
            width:outW,
            height:map.height,
            data:ret
        }
    },
    top: function (map, newHeight=0)  /* cuts only the top */ {
        newHeight = parseInt(newHeight)
        if (isNaN(newHeight) || newHeight < 1 || newHeight >= map.height) {
            newHeight = Math.round(map.height/2)
        }

        let ret = [];
        for (let j = 0; j < map.width*newHeight; j++ ) {
            ret.push(map.data[j]);      
        }  
        return { 
            name: map.name,
            width:map.width,
            height:newHeight,
            data:ret
        }
    },
    bottom: function (map, newHeight=0) /* cuts only the bottom */ {
        newHeight = parseInt(newHeight)
        if (isNaN(newHeight) || newHeight < 1 || newHeight >= map.height) {
            newHeight = Math.floor(map.height/2) || 1
        }
        // PORT FIX (diverges from buildinggame): the source read rows
        // newHeight..2*newHeight — out of bounds whenever newHeight > h/2
        // (odd heights with the default: undefined holes → 0-bytes, hit on
        // 17% of random 5-chains in fuzzing). Keep the LAST newHeight rows,
        // valid for every 1<=N<height.
        let ret = [];
        let start = (map.height - newHeight) * map.width;
        let count = newHeight * map.width;
        for (let j = 0; j < count; j++ ) {
            ret.push(map.data[start+j]);
        }
        return {
            name: map.name,
            width:map.width,
            height:newHeight,
            data:ret
        }
    },
    left: function (map, newWidth=0)  /* cuts only the left */ {
        console.log(newWidth)
        newWidth = parseInt(newWidth)
        if (isNaN(newWidth) || newWidth < 1 || newWidth >= map.width) {
            newWidth = Math.round(map.width/2)
        }

        let ret = [];
        for (let j = 0; j < map.height; j++ ) {
            for (let i = 0; i<newWidth; i++) {
                ret.push(map.data[(j*map.width)+i]);
            }
        } 
        return { 
            name: map.name,
            width:newWidth,
            height:map.height,
            data:ret
        }
    },
    right: function (map, newWidth=0)  /* cuts only the right */  {
        newWidth = parseInt(newWidth)
        if (isNaN(newWidth) || newWidth < 1 || newWidth >= map.width) {
            newWidth = Math.floor(map.width/2) || 1
        }
        // PORT FIX (diverges from buildinggame): the source offset was
        // newWidth (crossed into the next row + 1 OOB read on odd widths).
        // Keep the LAST newWidth columns, valid for every 1<=N<width.
        let ret = [];
        let off = map.width - newWidth;
        for (let j = 0; j < map.height; j++ ) {
            for (let i = 0; i<newWidth; i++) {
                ret.push(map.data[(j*map.width)+off+i]);
            }
        }
        return {
            name: map.name,
            width:newWidth,
            height:map.height,
            data:ret
        }
    },
    border: function (map) /* 1pixel rock border all around*/ {
        const allowedMat = [MATERIAL.ROCK,MATERIAL.UNDEF,MATERIAL.WORM]
        const rockReplace = 24
        let ret = map.data.slice(0); //copy
        let j = 0;
        for (let i = 0; i<map.width; i++) { // top border
            if (!allowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                ret[(j*map.width)+i]= rockReplace
            }
        }
        j = map.height-1
        for (let i = 0; i<map.width; i++) { // bottom border
            if (!allowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                ret[(j*map.width)+i]= rockReplace
            }
        }
        let i = 0;
        for (let j = 0; j < map.height; j++ ) { //left border
            if (!allowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                ret[(j*map.width)+i]= rockReplace
            }
        } 
        i = map.width-1;
        for (let j = 0; j < map.height; j++ ) { //right border
            if (!allowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                ret[(j*map.width)+i]= rockReplace
            }
        } 
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    borderbottom: function (map, colornum=null) /* 1pixel rock border only bottom*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        const allowedMat = [MATERIAL.ROCK,MATERIAL.UNDEF,MATERIAL.WORM]
        const rockReplace = 24
        let ret = map.data.slice(0); //copy
        let j = map.height-1
        for (let i = 0; i<map.width; i++) { // bottom border
            if (!allowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                ret[(j*map.width)+i]= color===false? rockReplace: color
            }
        }       
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    dirt2rock: function (map, colornum=null /* uses this color instead of random rock can be any color number from 0 to 255 */) /* changes all dirt materials to rock*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        const tobereplacedMat = [MATERIAL.BG_DIRT,MATERIAL.BG_DIRT_2,MATERIAL.DIRT, MATERIAL.DIRT_2]
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= color===false? randomGreyRock(): color
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    undef2rock: function (map, colornum=null /* uses this color instead of random rock can be any color number from 0 to 255 */) /* changes all undef materials to rock*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        const tobereplacedMat = [MATERIAL.UNDEF, MATERIAL.WORM]
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= color===false? randomGreyRock(): color
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    rock2dirt: function (map, colornum=null /* uses this color instead of random dirt can be any color number from 0 to 255 */) /* changes all rock materials to dirt*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        const tobereplacedMat = [MATERIAL.ROCK]
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= color===false? randomBrownDirt(): color
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },  
    bg2dirt: function (map, colornum=null /* uses this color instead of random dirt can be any color number from 0 to 255 */) /* changes all background materials to dirt*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        const tobereplacedMat = [MATERIAL.BG, MATERIAL.BG_DIRT, MATERIAL.BG_DIRT_2, MATERIAL.BG_SEESHADOW]
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= color===false? randomBrownDirt(): color
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },   
    replacecolor: function (map, colornum=null /* color to be replaced number from 0 to 255 */, color2num=null /* new color */) {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? randomColor() : color
        let color2 = parseInt(color2num)
        color2 = isNaN(color2) || color2num===null || color2 > 255 || color2 < 0? randomColor() : color2
        
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (color == map.data[(j*map.width)+i]) {
                    ret[(j*map.width)+i]= color2
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    nodirt: function (map)  /* removes all dirt */ {
        const tobereplacedMat = [MATERIAL.BG_DIRT,MATERIAL.BG_DIRT_2,MATERIAL.DIRT, MATERIAL.DIRT_2]
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= randomBG()
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    fillbg: function (map)  /* fill everything with random background */   {       
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                    ret[(j*map.width)+i]= randomBG()                
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    borderizex: function (map, colortop=29, colorright=29, colorbott=19, colorleft=19, pixeltop=1, pixelright=1, pixelbott=1, pixelleft=1, mat='rock', withmat='bg')  /* adds a border between materials (defaults to rock & bg) */  {
        let ret = map.data.slice(0); //copy

        for (const idx in ['colortop', 'colorright', 'colorbott', 'colorleft']) {
            const ai = 1*idx+1
            let color = arguments[ai]
            color = parseInt(color);
            arguments[ai] = isNaN(color) || arguments[ai]===null || color > 255 || color < 0? 29 : color
        }


        for (const idx in ['pixeltop', 'pixelright', 'pixelleft', 'pixelbott']) {
            const ai = 1*idx+5
            let pixel = parseInt(arguments[ai]);
            pixel = isNaN(pixel) ? 0 : pixel
            pixel = pixel > 40 ? 40 : pixel
            arguments[ai] = pixel
        }

        if (typeof MAT_GROUP[mat] == 'undefined') {
            mat = withmat=='rock'?'bg':'rock'
        }
        if (typeof MAT_GROUP[withmat] == 'undefined' || mat==withmat ) {
            withmat = mat=='rock'?'bg':'rock'
        }
       
        const top = 1;
        const right = 2;
        const bottom = 3;
        const left = 4;
  
        const is_next_to_other_mat = (j,i) => {    
            if (pixelbott)
            for (let jj = j; (jj <= j+(1*pixelbott)); jj++) {                
                if (MAT_GROUP[withmat].includes(defaultMaterials[map.data[(jj*map.width)+i]])) {            
                   return bottom
                }
            } 
            if (pixelright)
            for (let ii = i+1; (ii <= i+(1*pixelright)); ii++) {
                if (MAT_GROUP[withmat].includes(defaultMaterials[map.data[(j*map.width)+ii]])) {                   
                    return right
                }
            }
            if (pixeltop)
            for (let jj = j-(1*pixeltop); (jj < j); jj++) {                
                if (MAT_GROUP[withmat].includes(defaultMaterials[map.data[(jj*map.width)+i]])) {
                    return top
                }
            } 
            if (pixelleft)
            for (let ii = i-1; (ii >= i-(1*pixelleft)); ii--) {
                if (MAT_GROUP[withmat].includes(defaultMaterials[map.data[(j*map.width)+ii]])) {
                    return left
                }
            }         
            return -1;
        }
        
        for (let j = 0; j < map.height; j++) {            
            for (let i = 0; i<map.width; i++) {
                let curr_idx = (j*map.width)+i
                let curr_c =map.data[curr_idx];
                let curr_mat = defaultMaterials[curr_c]
                if (MAT_GROUP[mat].includes(curr_mat)) {
                    let dir = is_next_to_other_mat(j, i)
                    if (dir>0) {
                        switch (dir) {
                            case top:
                                ret[curr_idx] = colortop;
                            break;
                            case right:
                                ret[curr_idx] = colorright;
                            break;
                            case bottom:
                                ret[curr_idx] = colorbott;
                            break;
                            case left:
                                ret[curr_idx] = colorleft;
                            break;
                        }
                    }                   
                }
            }            
        }
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    borderize: function (map, replacewithcolor=29, pixelx=1, pixely=1, mat='rock', withmat='bg')  /* adds a border between materials (defaults to rock & bg) */  {
        let ret = map.data.slice(0); //copy

        pixelx = parseInt(pixelx);
        pixelx = isNaN(pixelx) ? 0 : pixelx
        pixelx = pixelx > 40 ? 40 : pixelx

        pixely = parseInt(pixely);
        pixely = isNaN(pixely) ? 0 : pixely
        pixely = pixely > 40 ? 40 : pixely

        let color = parseInt(replacewithcolor)
        color = isNaN(color) || replacewithcolor===null || color > 255 || color < 0? 29 : color

        if (typeof MAT_GROUP[mat] == 'undefined') {
            mat = withmat=='rock'?'bg':'rock'
        }
        if (typeof MAT_GROUP[withmat] == 'undefined' || mat==withmat ) {
            withmat = mat=='rock'?'bg':'rock'
        }
        const is_next_to_other_mat = (j,i) => {
            for (let jj = j-pixely; (jj < map.height) && (jj <= j+pixely); jj++) {
                for (let ii = i-pixelx; (ii < map.width) && (ii <= i+pixelx); ii++) {
                    if ((jj==j && ii==i) || (jj<0 || ii<0)) continue;
                    if (MAT_GROUP[withmat].includes(defaultMaterials[map.data[(jj*map.width)+ii]])) {
                        return true;
                    }
                }
            }
            return false;
        }
        
        for (let j = 0; j < map.height; j++) {            
            for (let i = 0; i<map.width; i++) {
                let curr_idx = (j*map.width)+i
                let curr_c =map.data[curr_idx];
                let curr_mat = defaultMaterials[curr_c]
                if (MAT_GROUP[mat].includes(curr_mat) && is_next_to_other_mat(j, i)) {
                    ret[curr_idx] = color
                }
                

            }            
        }
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    fillgaps: function (map, colornum=null, pixel=0 /* number of pixels added to the thresolds | x y thresolds are 3x7 by default */) /* tries filling gaps with random rock */ {   
        pixel = parseInt(pixel)
        pixel = isNaN(pixel) ? 0 : pixel
        pixel = pixel > 40 ? 40 : pixel
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        let maxHorizontalPixels = 3+pixel 
        let maxVerticalPixels = 7+pixel
        let ret = map.data.slice(0); //copy
        const allowedMat = [MATERIAL.UNDEF,MATERIAL.WORM,MATERIAL.ROCK]       
                
        for (let j = 0; j < map.height; j++ ) {                          
            let lastAllowedH = -1
            let nextAllowedH = -1           
            for (let i = 0; i<map.width; i++) {    
                let currentIsAllowed = allowedMat.includes(defaultMaterials[ret[(j*map.width)+i]]) 
                if (currentIsAllowed) {
                    lastAllowedH = i  
                    nextAllowedH = -1                                   
                    continue
                } 

                if (nextAllowedH==-1 && (i+1)<map.width) {       
                    nextAllowedH = (() => {
                        for (let ii = 1+i; ii<map.width; ii++) { 
                            if (allowedMat.includes(defaultMaterials[ret[(j*map.width)+ii]])) {
                                return ii
                            }
                        } 
                        return map.width
                    })()                            
                                        
                }
                                    
                if (i < nextAllowedH && i > lastAllowedH && (nextAllowedH-lastAllowedH)<=maxHorizontalPixels) {                         
                    ret[(j*map.width)+i] = color===false?randomGreyRock():color
                }

            }
                
        } 

        for (let i = 0; i<map.width; i++) {                                   
            let lastAllowedV = -1
            let nextAllowedV = -1           
            for (let j = 0; j < map.height; j++ ) {   
                let currentIsAllowed = allowedMat.includes(defaultMaterials[ret[(j*map.width)+i]]) 
                if (currentIsAllowed) {
                    lastAllowedV = j  
                    nextAllowedV = -1                                     
                    continue
                } 

                if (nextAllowedV==-1 && (j+1)<map.height) {       
                    nextAllowedV = (() => {
                        for (let jj = 1+j; jj < map.height; jj++ ) {                         
                            if (allowedMat.includes(defaultMaterials[ret[(jj*map.width)+i]])) {
                                return jj
                            }
                        } 
                        return map.height
                    })()                            
                                        
                }
                                    
                if (j < nextAllowedV && j > lastAllowedV && (nextAllowedV-lastAllowedV)<=maxVerticalPixels) {                                                      
                    ret[(j*map.width)+i] = color===false?randomGreyRock():color
                }

            }
                
        }  
        
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    clearbg: function (map) /* replace all background by a random background color */ {      
        const tobereplacedMat = [MATERIAL.BG_DIRT,MATERIAL.BG_DIRT_2,MATERIAL.BG, MATERIAL.BG_SEESHADOW] 
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++ ) { 
            for (let i = 0; i<map.width; i++) { 
                if (tobereplacedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])) {
                    ret[(j*map.width)+i]= randomBG()                
                }
            }
        }    
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }
    },
    reduce: function (map) /* reduce each pixel | 4 pixels = 1 pixel */ {       
        let ret = { 
            name: map.name,
            width:Math.round(map.width/2),
            height:Math.round(map.height/2),
            data:[]
        }
        for (let j = 0; j <ret.height; j++ ) { 
            for (let i = 0; i<ret.width; i++) { 
                    ret.data.push(map.data[(j*2*map.width)+i*2]??randomGreyRock())
            }
        }    

        return ret
    },
    addbg: function (map, top=10, right=10, bottom=10, left=10, colornum=null /* color to be used default is random background */ )  /* adds random background around current map*/ {
        let color = parseInt(colornum)
        color = isNaN(color) || colornum===null || color > 255 || color < 0? false : color

        let validatePixelValue = (s, c) => {
            let r = parseInt(s)
            if (isNaN(r) || r < 0) {
                return 0
            }
            
            if ((r+Math.round(c/2))>maxMaxWidthHeight) {
                return maxMaxWidthHeight-Math.round(c/2)
            }
            return r
        }
        top = validatePixelValue(top, map.height)
        right = validatePixelValue(right, map.width)
        bottom = validatePixelValue(bottom, map.height)
        left = validatePixelValue(left, map.width)
        // PORT FIX (diverges from buildinggame): validatePixelValue bounds each
        // side against HALF the map dimension (r + c/2 <= cap), so a single side
        // could already exceed the cap (350 + 2825 = 3175) and both sides
        // together reached ~2x cap (addbg:2900:...:2900 on 504x350 → 6000²).
        // Clamp each axis sequentially so map + both sides never exceeds the cap.
        top = Math.min(top, Math.max(0, maxMaxWidthHeight - map.height))
        bottom = Math.min(bottom, Math.max(0, maxMaxWidthHeight - map.height - top))
        left = Math.min(left, Math.max(0, maxMaxWidthHeight - map.width))
        right = Math.min(right, Math.max(0, maxMaxWidthHeight - map.width - left))


        let ret = [];
        var y = 0;
        
        const newHeight = map.height+top+bottom
        const newWidth = map.width+left+right
        
        for (let j = 0; j < newHeight; j++ ) {            
            var x = 0
            for (let i = 0; i<newWidth; i++) {
                if (j<top || j>=(map.height+top) || i<left || i>=(map.width+left)) {
                    ret.push(color===false?randomBG():color)
                } else {
                    ret.push(map.data[(y*map.width)+x]);
                    x++
                }                
                
            }
            if (j>=top && j<(map.height+top-1)) {
                y++
            }            
        } 
        return { 
            name: map.name,
            width:newWidth,
            height:newHeight,
            data:ret
        }      
    },
    autocrop: function (map)  /* automatically crops the map around any non BG or SEE SHADOW pixels | BG dirt is kept */ {
        const notAllowedMat = [MATERIAL.BG,MATERIAL.BG_SEESHADOW]
        let top = -1
        let right = -1
        let bottom = -1
        let left = -1
        let newWidth=map.width;
        let newHeight=map.height
        
        let ret = [];

        for (let j = 0; j < map.height; j++ ) {            
            for (let i = 0; i<map.width; i++) {
                    let isAllowed = !notAllowedMat.includes(defaultMaterials[map.data[(j*map.width)+i]])
                    if (isAllowed) {
                        if (top<0) {
                            top=j
                        }
                        if (right<i) {
                            right=i
                        }
                        if (bottom<j) {
                            bottom=j
                        }
                        if (left<0 || left>i) {
                            left=i                            
                        }
                    }
                
            }                        
        }
        newHeight = bottom-top+1
        newWidth = right-left+1
        
        for (let j = top; j < (bottom+1); j++ ) {            
            for (let i = left; i<(right+1); i++) {                    
                ret.push(map.data[(j*map.width)+i]);
                
            }                        
        } 

        return { 
            name: map.name,
            width:newWidth,
            height:newHeight,
            data:ret
        }      
    },
    grid: function (map,x=50, y=50, color=6)  /* draws a grid on top of the map x y & zx zy */ {
        let ret = map.data.slice(0); //copy
        for (let j = 0; j < map.height; j++) {            
            for (let i = 0; i<map.width; i++) {
                let curr_idx = (j*map.width)+i
                let curr_c =map.data[curr_idx];
               
                if (i%x==0 || j %y==0) {
                    ret[curr_idx] = color
                }
                

            }            
        }
        return { 
            name: map.name,
            width:map.width,
            height:map.height,
            data:ret
        }      
    },
    crop: function (map,x,y,zx,zy)  /* crops the map between point x y & zx zy */ {
        let validate = (def, lower, higher,max, lowerThan=true) => {
            if (typeof lower == 'undefined' || isNaN(lower)) {
                lower = def
            } else {
                lower = parseInt(lower)
            }
            
            if (typeof higher == 'undefined' || isNaN(lower)) {
                higher = def
            } else {
                higher = parseInt(higher)
            }
            if (higher == lower) return def
            let retv = def
            if (lowerThan) {
                retv = lower<higher?lower:higher
            } else {
                retv = lower>higher?lower:higher
            }
            if (retv>max) {
                return max
            }
            return retv
        }
        const top = validate(0, y, zy,map.height-1)
        const left = validate(0, x, zx, map.width-1)

        const right = validate(map.width-1, x, zx, map.width-1, false)
        const bottom = validate(map.height-1, y, zy,map.height-1, false)
        
        console.log(top, left, right, bottom)

        const newWidth=right-left+1;
        const newHeight=bottom-top+1;
        
        console.log(newWidth, newHeight);

        let ret = [];
        console.log(ret.length)
        let idx = 0;
        for (let j = top; j < (bottom+1); j++ ) {            
            for (let i = left; i<(right+1); i++) {                    
                ret.push(map.data[(j*map.width)+i]);
                
            }                        
        } 
        console.log(ret.length, idx)
        return { 
            name: map.name,
            width:newWidth,
            height:newHeight,
            data:ret
        }      
    },
}

var effectList=Object.keys(effects);