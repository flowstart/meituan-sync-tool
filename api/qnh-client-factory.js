/**
 * 牵牛花客户端工厂
 * 用于在 V1（稳定版）和 V2（模块化版）之间切换
 * 
 * 使用方式：
 * 
 * 1. 在代码中设置环境变量：
 *    process.env.QNH_CLIENT_VERSION = 'v2';
 * 
 * 2. 或在启动时设置：
 *    QNH_CLIENT_VERSION=v2 npm start
 * 
 * 3. 或在代码中直接指定：
 *    const createClient = require('./api/qnh-client-factory');
 *    const client = createClient('v2', cookies);
 */

/**
 * 创建牵牛花客户端
 * @param {string} version - 版本号 'v1' 或 'v2'，默认 'v1'
 * @param {string|Object} config - Cookie 或配置对象
 * @returns {QianniuhuaClient}
 */
function createQianniuhuaClient(version = null, config) {
    // 优先级：参数 > 环境变量 > 默认值
    const clientVersion = version || process.env.QNH_CLIENT_VERSION || 'v1';
    
    if (clientVersion === 'v2') {
        console.log('🔧 [QNH Factory] 使用 V2 客户端（模块化版本）');
        const QianniuhuaClientV2 = require('./qnh-client-v2');
        return new QianniuhuaClientV2(config);
    } else {
        console.log('🔧 [QNH Factory] 使用 V1 客户端（稳定版本）');
        const QianniuhuaClient = require('./qnh-client');
        return new QianniuhuaClient(config);
    }
}

/**
 * 获取当前使用的版本
 * @returns {string} 'v1' 或 'v2'
 */
function getCurrentVersion() {
    return process.env.QNH_CLIENT_VERSION || 'v1';
}

/**
 * 设置全局使用的版本
 * @param {string} version - 'v1' 或 'v2'
 */
function setGlobalVersion(version) {
    if (version !== 'v1' && version !== 'v2') {
        throw new Error(`无效的版本号: ${version}，只支持 'v1' 或 'v2'`);
    }
    process.env.QNH_CLIENT_VERSION = version;
    console.log(`🔧 [QNH Factory] 全局版本已设置为: ${version}`);
}

/**
 * 直接获取 V1 客户端类
 */
function getV1Client() {
    return require('./qnh-client');
}

/**
 * 直接获取 V2 客户端类
 */
function getV2Client() {
    return require('./qnh-client-v2');
}

// 默认导出
module.exports = createQianniuhuaClient;

// 命名导出
module.exports.createClient = createQianniuhuaClient;
module.exports.getCurrentVersion = getCurrentVersion;
module.exports.setGlobalVersion = setGlobalVersion;
module.exports.getV1Client = getV1Client;
module.exports.getV2Client = getV2Client;

// 快捷方式
module.exports.v1 = getV1Client;
module.exports.v2 = getV2Client;

