/**
 * 牵牛花 API - 门店管理模块
 * 负责：门店列表查询、门店信息获取
 */

class StoreModule {
    /**
     * 构造函数
     * @param {QNHBaseClient} baseClient - 基础客户端实例
     */
    constructor(baseClient) {
        this.base = baseClient;
        this._storesCache = null;
    }

    /**
     * 获取所有门店信息
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<Object>} {门店ID: 门店名称}
     */
    async getAll(forceRefresh = false) {
        console.log(`[QNH Store] getAll called, forceRefresh=${forceRefresh}`);

        if (this._storesCache && !forceRefresh) {
            console.log('[QNH Store] 返回缓存的门店数据');
            return this._storesCache;
        }

        const url = 'https://qnh.meituan.com/goldengateway/poi/queryPoiTree';
        const params = new URLSearchParams({
            showType: '1',
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const data = {
            careErp: 'y',
            showType: 1,
            entityType: [3, 5, 6]
        };

        const result = await this.base.request('POST', fullUrl, data);

        const stores = {};
        const dataField = result.data;

        if (!dataField) {
            console.warn('[QNH Store] API返回的data字段为空');
            return stores;
        }

        if (!Array.isArray(dataField)) {
            console.error(`[QNH Store] data字段类型错误，期望list，实际: ${typeof dataField}`);
            throw new Error('获取门店列表失败：数据格式错误');
        }

        // 递归提取所有 itemType=3 的门店节点
        const extractStores = (node) => {
            if (!node) return;
            
            // itemType=3 表示门店
            if (node.itemType === 3 && node.itemCode && node.itemName) {
                stores[node.itemCode] = node.itemName;
            }
            
            // 递归处理子节点
            if (Array.isArray(node.children)) {
                node.children.forEach(child => extractStores(child));
            }
        };

        dataField.forEach(rootNode => extractStores(rootNode));

        this._storesCache = stores;
        console.log(`[QNH Store] 获取到 ${Object.keys(stores).length} 个门店`);

        return stores;
    }

    /**
     * 获取门店列表（数组格式）
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<Array>} [{id, name}, ...]
     */
    async getList(forceRefresh = false) {
        const stores = await this.getAll(forceRefresh);
        return Object.entries(stores).map(([id, name]) => ({
            id: id,
            name: name
        }));
    }

    /**
     * 根据门店ID获取门店名称
     * @param {string} storeId - 门店ID
     * @returns {Promise<string|null>} 门店名称
     */
    async getName(storeId) {
        const stores = await this.getAll();
        return stores[storeId] || null;
    }

    /**
     * 验证门店ID是否存在
     * @param {string} storeId - 门店ID
     * @returns {Promise<boolean>}
     */
    async exists(storeId) {
        const stores = await this.getAll();
        return storeId in stores;
    }

    /**
     * 清除缓存
     */
    clearCache() {
        this._storesCache = null;
        console.log('[QNH Store] 缓存已清除');
    }

    /**
     * 静态方法：验证Cookie（获取门店列表）
     * @param {string} cookieStr - Cookie字符串
     * @returns {Promise<Object>} {success, stores, storeList, error}
     */
    static async validateCookie(cookieStr) {
        try {
            const QNHBaseClient = require('./base');
            const client = new QNHBaseClient(cookieStr);
            const storeModule = new StoreModule(client);

            const stores = await storeModule.getAll();

            if (Object.keys(stores).length > 0) {
                return {
                    success: true,
                    stores: stores,
                    storeList: Object.entries(stores).map(([id, name]) => ({
                        id: id,
                        name: name
                    }))
                };
            } else {
                return {
                    success: false,
                    error: 'Cookie无效或无门店权限'
                };
            }
        } catch (error) {
            console.error('[QNH Store] Cookie验证失败:', error);
            return {
                success: false,
                error: error.message || '网络请求失败'
            };
        }
    }
}

module.exports = StoreModule;

