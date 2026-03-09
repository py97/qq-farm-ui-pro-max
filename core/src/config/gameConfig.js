/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('node:fs');
const path = require('node:path');
const { ensureAssetCacheDir, getResourcePath } = require('./runtime-paths');
const { cleanupGeneratedItemIconCache } = require('../services/ui-assets');

// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;  // 累计经验表，索引为等级

// ============ 植物配置 ============
let plantConfig = null;
const plantMap = new Map();  // id -> plant
const seedToPlant = new Map();  // seed_id -> plant
const fruitToPlant = new Map();  // fruit_id -> plant (果实ID -> 植物)
let itemInfoConfig = null;
const itemInfoMap = new Map();  // item_id -> item
const seedItemMap = new Map();  // seed_id -> item(type=5)
const seedImageMap = new Map(); // seed_id -> image url
const seedAssetImageMap = new Map(); // asset_name (Crop_xxx) -> image url
const itemImageMap = new Map(); // item_id -> image url
const itemIconKeyImageMap = new Map(); // normalized icon/asset key -> image url

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i;

function normalizeIconLookupKey(value) {
    return String(value || '')
        .replace(/\/spriteFrame$/i, '')
        .replace(IMAGE_EXT_RE, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function getIconLookupKeys(value) {
    const raw = String(value || '')
        .replace(/\/spriteFrame$/i, '')
        .replace(IMAGE_EXT_RE, '')
        .trim();
    if (!raw) return [];

    const keys = [];
    const addKey = (candidate) => {
        const normalized = normalizeIconLookupKey(candidate);
        if (normalized && !keys.includes(normalized)) {
            keys.push(normalized);
        }
    };

    addKey(raw);
    const segments = raw.split('/').filter(Boolean);
    if (segments.length > 0) {
        addKey(segments[segments.length - 1]);
    }
    return keys;
}

function toStaticGameConfigUrl(fullPath) {
    const relPath = path.relative(getResourcePath('gameConfig'), fullPath);
    const safePath = relPath.split(path.sep).map(seg => encodeURIComponent(seg)).join('/');
    return `/game-config/${safePath}`;
}

function walkImageFiles(dirPath, visitor) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            walkImageFiles(fullPath, visitor);
            continue;
        }
        if (!IMAGE_EXT_RE.test(entry.name)) continue;
        visitor(fullPath, entry.name);
    }
}

function loadItemIconMappings(configDir) {
    itemImageMap.clear();
    itemIconKeyImageMap.clear();
    const itemIconDir = path.join(configDir, 'item_icons');
    if (!fs.existsSync(itemIconDir)) return;

    walkImageFiles(itemIconDir, (fullPath, filename) => {
        const staticUrl = toStaticGameConfigUrl(fullPath);
        const basename = path.basename(filename, path.extname(filename));
        const byId = basename.match(/^(\d+)(?:[_-].*)?$/);
        if (byId) {
            const itemId = Number(byId[1]) || 0;
            if (itemId > 0 && !itemImageMap.has(itemId)) {
                itemImageMap.set(itemId, staticUrl);
            }
        }

        const normalizedBase = normalizeIconLookupKey(basename);
        if (normalizedBase && !itemIconKeyImageMap.has(normalizedBase)) {
            itemIconKeyImageMap.set(normalizedBase, staticUrl);
        }
    });

    console.warn(`[配置] 已加载物品图标映射 (${itemImageMap.size} 项ID，${itemIconKeyImageMap.size} 项键值)`);
}

function cleanupGeneratedIconCache() {
    try {
        const result = cleanupGeneratedItemIconCache({
            dirPath: ensureAssetCacheDir('item-icons'),
            validItemIds: Array.from(itemInfoMap.keys()),
        });
        if (result.deleted.length > 0) {
            console.warn(`[配置] 已清理过期物品图标缓存 (${result.deleted.length} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 清理物品图标缓存失败:', e.message);
    }
}

function getGeneratedIconPalette(item) {
    const type = Number(item && item.type) || 0;
    const rarity = Math.max(0, Number(item && item.rarity) || 0);
    const palettes = {
        2: ['#eab308', '#f97316', '#1f2937'],
        5: ['#22c55e', '#14b8a6', '#ecfeff'],
        6: ['#f97316', '#ef4444', '#fff7ed'],
        7: ['#0ea5e9', '#2563eb', '#eff6ff'],
        9: ['#8b5cf6', '#7c3aed', '#f5f3ff'],
        11: ['#ec4899', '#be185d', '#fff1f2'],
        12: ['#eab308', '#ca8a04', '#fefce8'],
    };
    const [start, end, text] = palettes[type] || ['#475569', '#1e293b', '#f8fafc'];
    const badgeFill = rarity >= 4 ? '#fde68a' : (rarity >= 2 ? '#c4b5fd' : '#cbd5e1');
    const badgeText = rarity >= 4 ? '#92400e' : (rarity >= 2 ? '#5b21b6' : '#334155');
    return { start, end, text, badgeFill, badgeText };
}

function getGeneratedIconLabel(itemId, item) {
    const id = Number(itemId) || 0;
    const type = Number(item && item.type) || 0;
    if (type === 5) return 'SD';
    if (type === 6) return 'FR';
    if (type === 7) return 'FT';
    if (type === 9) return 'DG';
    if (type === 11) return 'BX';
    if (type === 12) return 'CP';
    if (id === 1001 || id === 1) return 'GD';
    if (id === 1002) return 'TK';
    if (id === 1101) return 'XP';
    return 'IT';
}

function buildGeneratedIconSvg(itemId, item) {
    const palette = getGeneratedIconPalette(item);
    const label = getGeneratedIconLabel(itemId, item);
    const rarity = Math.max(0, Number(item && item.rarity) || 0);
    const rarityLabel = String(Math.max(1, Math.min(9, rarity || 1)));
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="bg" x1="18" y1="14" x2="112" y2="116" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette.start}"/>
      <stop offset="1" stop-color="${palette.end}"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="108" height="108" rx="30" fill="url(#bg)"/>
  <rect x="18" y="18" width="92" height="92" rx="24" fill="rgba(255,255,255,0.08)"/>
  <circle cx="95" cy="33" r="15" fill="${palette.badgeFill}" opacity="0.95"/>
  <text x="95" y="38" text-anchor="middle" font-size="15" font-weight="700" fill="${palette.badgeText}" font-family="Arial, sans-serif">${rarityLabel}</text>
  <text x="64" y="73" text-anchor="middle" font-size="34" font-weight="700" fill="${palette.text}" font-family="Arial, sans-serif" letter-spacing="2">${label}</text>
  <text x="64" y="96" text-anchor="middle" font-size="12" font-weight="600" fill="${palette.text}" fill-opacity="0.85" font-family="Arial, sans-serif">#${Number(itemId) || 0}</text>
</svg>`.trim();
}

function getGeneratedItemImageUrl(itemId, item) {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';
    const iconDir = ensureAssetCacheDir('item-icons');
    const filename = `item-${id}.svg`;
    const fullPath = path.join(iconDir, filename);
    if (!fs.existsSync(fullPath)) {
        const svg = buildGeneratedIconSvg(id, item || itemInfoMap.get(id) || null);
        fs.writeFileSync(fullPath, svg, 'utf8');
    }
    return `/asset-cache/item-icons/${encodeURIComponent(filename)}`;
}

/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = getResourcePath('gameConfig');
    
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            // 构建累计经验表
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }
    
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.warn(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }

    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            itemInfoMap.clear();
            seedItemMap.clear();
            for (const item of itemInfoConfig) {
                const id = Number(item && item.id) || 0;
                if (id <= 0) continue;
                itemInfoMap.set(id, item);
                if (Number(item.type) === 5) {
                    seedItemMap.set(id, item);
                }
            }
            console.warn(`[配置] 已加载物品配置 (${itemInfoConfig.length} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }

    // 加载种子图片映射（seed_images_named）
    try {
        const seedImageDir = path.join(configDir, 'seed_images_named');
        seedImageMap.clear();
        seedAssetImageMap.clear();
        if (fs.existsSync(seedImageDir)) {
            const files = fs.readdirSync(seedImageDir);
            for (const file of files) {
                const filename = String(file || '');
                const fileUrl = `/game-config/seed_images_named/${encodeURIComponent(file)}`;

                // 1) id_..._Seed.png 命名，按 id 建立映射
                const byId = filename.match(/^(\d+)_.*\.(?:png|jpg|jpeg|webp|gif)$/i);
                if (byId) {
                    const seedId = Number(byId[1]) || 0;
                    if (seedId > 0 && !seedImageMap.has(seedId)) {
                        seedImageMap.set(seedId, fileUrl);
                    }
                }

                // 2) ...Crop_xxx_Seed.png 命名，按 asset_name 建立映射
                const byAsset = filename.match(/(Crop_\d+)_Seed\.(?:png|jpg|jpeg|webp|gif)$/i);
                if (byAsset) {
                    const assetName = byAsset[1];
                    if (assetName && !seedAssetImageMap.has(assetName)) {
                        seedAssetImageMap.set(assetName, fileUrl);
                    }
                }
            }
            console.warn(`[配置] 已加载种子图片映射 (${seedImageMap.size} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 seed_images_named 失败:', e.message);
    }

    try {
        loadItemIconMappings(configDir);
    } catch (e) {
        console.warn('[配置] 加载 item_icons 失败:', e.message);
    }

    cleanupGeneratedIconCache();
}

// ============ 等级经验相关 ============

/**
 * 获取等级经验表
 */
function getLevelExpTable() {
    return levelExpTable;
}

/**
 * 计算当前等级的经验进度
 * @param {number} level - 当前等级
 * @param {number} totalExp - 累计总经验
 * @returns {{ current: number, needed: number }} 当前等级经验进度
 */
function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };
    
    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);
    
    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;
    
    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

/**
 * 根据植物ID获取植物信息
 * @param {number} plantId - 植物ID
 */
function getPlantById(plantId) {
    return plantMap.get(plantId);
}

/**
 * 根据种子ID获取植物信息
 * @param {number} seedId - 种子ID
 */
function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId);
}

/**
 * 获取植物名称
 * @param {number} plantId - 植物ID
 */
function getPlantName(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

/**
 * 根据种子ID获取植物名称
 * @param {number} seedId - 种子ID
 */
function getPlantNameBySeedId(seedId) {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

/**
 * 获取植物的生长时间（秒）
 * @param {number} plantId - 植物ID
 */
function getPlantGrowTime(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases) return 0;
    
    // 解析 "种子:30;发芽:30;成熟:0;" 格式
    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += Number.parseInt(match[1]);
        }
    }
    return totalSeconds;
}

/**
 * 格式化时间
 * @param {number} seconds - 秒数
 */
function formatGrowTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

/**
 * 获取植物的收获经验
 * @param {number} plantId - 植物ID
 */
function getPlantExp(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.exp : 0;
}

/**
 * 根据果实ID获取植物名称
 * @param {number} fruitId - 果实ID
 */
function getFruitName(fruitId) {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

/**
 * 根据果实ID获取植物信息
 * @param {number} fruitId - 果实ID
 */
function getPlantByFruitId(fruitId) {
    return fruitToPlant.get(fruitId);
}

/**
 * 获取所有种子信息（用于备选）
 */
function getAllSeeds() {
    return Array.from(seedToPlant.values()).map(p => ({
        seedId: p.seed_id,
        name: p.name,
        requiredLevel: Number(p.land_level_need) || 0,
        price: getSeedPrice(p.seed_id),
        image: getSeedImageBySeedId(p.seed_id),
    }));
}

function getSeedImageBySeedId(seedId) {
    return seedImageMap.get(Number(seedId) || 0) || '';
}

function getItemImageById(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';

    // 内部函数：根据 ID 获取图片
    const getImg = (targetId) => {
        // 1. 优先按物品ID命中（如 20003_胡萝卜_Crop_3_Seed.png）
        const direct = seedImageMap.get(targetId);
        if (direct) return direct;

        // 2. 其次按 ItemInfo.asset_name 命中（如 Crop_3_Seed.png）
        const item = itemInfoMap.get(targetId);
        const assetName = item && item.asset_name ? String(item.asset_name) : '';
        if (assetName) {
            const byAsset = seedAssetImageMap.get(assetName);
            if (byAsset) return byAsset;
        }
        return '';
    };

    const getLocalItemImg = (targetId) => {
        const direct = itemImageMap.get(targetId);
        if (direct) return direct;
        const item = itemInfoMap.get(targetId);
        if (!item) return '';
        for (const iconKey of getIconLookupKeys(item.icon_res)) {
            const mapped = itemIconKeyImageMap.get(iconKey);
            if (mapped) return mapped;
        }
        for (const assetKey of getIconLookupKeys(item.asset_name)) {
            const mapped = itemIconKeyImageMap.get(assetKey);
            if (mapped) return mapped;
        }
        return '';
    };

    // 1. 尝试直接获取
    let img = getImg(id);
    if (img) return img;

    // 2. 如果是果实，尝试获取对应的种子图片
    const plant = getPlantByFruitId(id);
    if (plant && plant.seed_id) {
        img = getImg(plant.seed_id);
        if (img) return img;
    }

    img = getLocalItemImg(id);
    if (img) return img;

    return getGeneratedItemImageUrl(id, itemInfoMap.get(id) || null);
}

function getItemById(itemId) {
    return itemInfoMap.get(Number(itemId) || 0);
}

function getSeedPrice(seedId) {
    const item = seedItemMap.get(Number(seedId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getFruitPrice(fruitId) {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getAllPlants() {
    return Array.from(plantMap.values());
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    getAllPlants,
    getAllSeeds,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    getItemById,
    getItemImageById,
    getSeedPrice,
    getFruitPrice,
    getSeedImageBySeedId,
};
