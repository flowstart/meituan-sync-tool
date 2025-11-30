/**
 * 牵牛花 API 使用示例
 * 包含常见使用场景的完整代码示例
 */

const QianniuhuaClient = require('../qnh-client');

// ========== 示例1: 基础门店和商品查询 ==========
async function example1_BasicQueries() {
    console.log('\n========== 示例1: 基础查询 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    // 获取门店列表
    const stores = await client.stores.getAll();
    console.log('门店列表:', Object.keys(stores).length, '个门店');

    // 获取某个门店的商品
    const storeId = Object.keys(stores)[0];
    const products = await client.products.getList(storeId, 1, 10);
    console.log('商品列表:', products.list?.length, '个商品');

    // 获取商品详情
    if (products.list && products.list.length > 0) {
        const product = products.list[0];
        const detail = await client.products.getDetail(
            product.store?.poiId,
            product.spuId
        );
        console.log('商品详情:', detail.spuName);
    }
}

// ========== 示例2: 库存更新 ==========
async function example2_StockUpdate() {
    console.log('\n========== 示例2: 库存更新 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    const storeId = '1234567';
    const skuId = '9876543210';
    const newQuantity = 100;

    // 单个SKU更新
    const result = await client.stock.update(storeId, skuId, newQuantity, '测试更新');
    console.log('更新结果:', result ? '成功' : '失败');

    // 批量更新多个SKU
    const skuUpdates = [
        { skuId: 'sku1', newQuantity: 100, comment: '批量更新1' },
        { skuId: 'sku2', newQuantity: 200, comment: '批量更新2' }
    ];
    const batchResult = await client.stock.batchUpdate(storeId, skuUpdates);
    console.log('批量更新结果:', batchResult ? '成功' : '失败');

    // 根据条形码更新库存
    const barcodeUpdates = [
        { barcode: '6901234567890', quantity: 50 },
        { barcode: '6901234567891', quantity: 60 }
    ];
    const barcodeResult = await client.stock.updateByBarcodes(storeId, barcodeUpdates);
    console.log('条形码更新结果:', {
        找到: barcodeResult.found,
        未找到: barcodeResult.notFound,
        成功: barcodeResult.success,
        失败: barcodeResult.failed
    });
}

// ========== 示例3: 商品导出 ==========
async function example3_ProductExport() {
    console.log('\n========== 示例3: 商品导出 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    const storeId = '1234567';
    const exportPath = 'data/products_export.xlsx';

    // 导出商品到Excel（带重试机制）
    const result = await client.products.export(
        storeId,
        exportPath,
        3,  // 最多重试3次
        {
            log: (level, message) => {
                console.log(`[${level}] ${message}`);
            },
            shouldCancel: () => false  // 取消标志
        }
    );

    if (result) {
        console.log('导出成功:', result);
    } else {
        console.log('导出失败');
    }
}

// ========== 示例4: 租户商品操作（新功能）==========
async function example4_TenantProducts() {
    console.log('\n========== 示例4: 租户商品操作 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    // 查询租户商品列表
    const products = await client.tenant.getProducts(1, 20);
    console.log('租户商品数量:', products.list?.length);

    // 获取商品详情
    if (products.list && products.list.length > 0) {
        const spuId = products.list[0].spuId;
        const info = await client.tenant.getProductInfo(spuId);
        console.log('商品详情:', info.data?.name);
    }

    // 创建商品示例（需要完整的商品数据）
    const productData = {
        tenantSpu: {
            spuName: '测试商品',
            description: '这是一个测试商品',
            picUrlList: ['https://example.com/image.jpg'],
            skus: [
                {
                    spec: '500ml',
                    upcList: ['6901234567890'],
                    weightForUnit: 500,
                    weightUnit: '毫升(ml)',
                    skuSaleType: 1
                }
            ]
            // ... 更多字段
        },
        dataType: 1
    };

    // const createResult = await client.tenant.createProduct(productData);
    // console.log('创建结果:', createResult);
}

// ========== 示例5: 单个商品搬运（同后台）==========
async function example5_TransferSingleProduct() {
    console.log('\n========== 示例5: 单个商品搬运 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    const sourcePoiId = '1028785';  // 源门店POI ID
    const sourceSpuId = '1234567890';  // 源商品SPU ID

    // 搬运商品（不搬运库存）
    const result = await client.transfer.transferProduct(
        sourcePoiId,
        sourceSpuId,
        {
            categoryMapping: {
                '饮料': '12345',  // 分类映射：旧分类名 -> 新分类ID
                '零食': '67890'
            },
            copyStock: false  // 不搬运库存
        }
    );

    if (result.success) {
        console.log('搬运成功:', result.data.productName);
        if (result.data.fixed) {
            console.log('注意: 自动修复了组合品问题');
        }
    } else {
        console.error('搬运失败:', result.error);
    }
}

// ========== 示例6: 批量商品搬运 ==========
async function example6_BatchTransfer() {
    console.log('\n========== 示例6: 批量商品搬运 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    // 准备要搬运的商品列表
    const products = [
        { poiId: '1028785', spuId: '1234567890' },
        { poiId: '1028785', spuId: '1234567891' },
        { poiId: '1028785', spuId: '1234567892' }
    ];

    // 批量搬运（并发数为3）
    const result = await client.transfer.batchTransfer(
        products,
        {
            categoryMapping: {
                '饮料': '12345',
                '零食': '67890',
                '日用品': '11111'
            },
            copyStock: false
        },
        3  // 并发数
    );

    console.log('搬运结果:');
    console.log('  总计:', result.total);
    console.log('  成功:', result.success);
    console.log('  失败:', result.failed);

    // 查看详细报告
    const report = client.transfer.getProgressReport(result);
    console.log('成功率:', report.successRate);
    console.log('失败商品:', report.failedProducts);

    // 导出失败商品
    if (result.failed > 0) {
        const exportPath = client.transfer.exportFailedProducts(result);
        console.log('失败商品已导出到:', exportPath);
    }
}

// ========== 示例7: 跨后台商品搬运 ==========
async function example7_CrossAccountTransfer() {
    console.log('\n========== 示例7: 跨后台商品搬运 ==========');
    
    // 方法1: 使用静态工厂方法
    const transfer = QianniuhuaClient.createCrossAccountTransfer(
        'source_cookies_here',  // A后台Cookie
        'target_cookies_here'   // B后台Cookie
    );

    // 搬运商品
    const result = await transfer.transferProduct(
        '1028785',
        '1234567890',
        {
            categoryMapping: { '饮料': '12345' },
            copyStock: true,  // 同时搬运库存
            targetStoreIds: ['target_store_1', 'target_store_2']
        }
    );

    console.log('跨后台搬运结果:', result.success ? '成功' : '失败');

    // 方法2: 使用实例方法
    const sourceClient = new QianniuhuaClient('source_cookies_here');
    const targetClient = new QianniuhuaClient('target_cookies_here');
    const transfer2 = sourceClient.createTransfer(targetClient);

    // 批量搬运
    const products = [
        { poiId: '1028785', spuId: '1234567890' },
        { poiId: '1028785', spuId: '1234567891' }
    ];

    const batchResult = await transfer2.batchTransfer(products, {
        categoryMapping: { '饮料': '12345' }
    }, 5);

    console.log('批量搬运:', batchResult);
}

// ========== 示例8: 整店商品搬运 ==========
async function example8_TransferAllProducts() {
    console.log('\n========== 示例8: 整店商品搬运 ==========');
    
    const sourceClient = new QianniuhuaClient('source_cookies_here');
    const targetClient = new QianniuhuaClient('target_cookies_here');
    const transfer = sourceClient.createTransfer(targetClient);

    const sourceStoreId = '1234567';
    const targetStoreId = '7654321';

    // 搬运整个门店的商品
    const result = await transfer.transferAllProducts(
        sourceStoreId,
        targetStoreId,
        {
            categoryMapping: {
                '饮料': '12345',
                '零食': '67890',
                '日用品': '11111'
            },
            copyStock: true,   // 搬运库存
            pageSize: 20,      // 每页20个商品
            maxProducts: 100   // 最多搬运100个商品（测试时使用）
        }
    );

    console.log('整店搬运结果:');
    console.log('  总计:', result.total);
    console.log('  成功:', result.success);
    console.log('  失败:', result.failed);

    // 生成详细报告
    const report = transfer.getProgressReport(result);
    console.log('成功率:', report.successRate);
    
    // 列出成功的商品
    console.log('\n成功搬运的商品:');
    report.successProducts.forEach(p => {
        console.log(`  - ${p.name} (spuId: ${p.spuId})${p.fixed ? ' [已自动修复]' : ''}`);
    });

    // 列出失败的商品
    if (report.failedProducts.length > 0) {
        console.log('\n失败的商品:');
        report.failedProducts.forEach(p => {
            console.log(`  - spuId: ${p.spuId}, 错误: ${p.error}`);
        });
    }
}

// ========== 示例9: 自定义商品创建流程 ==========
async function example9_CustomProductCreation() {
    console.log('\n========== 示例9: 自定义商品创建 ==========');
    
    const sourceClient = new QianniuhuaClient('source_cookies_here');
    const targetClient = new QianniuhuaClient('target_cookies_here');

    // 1. 从源后台获取商品详情
    const sourceDetail = await sourceClient.products.getDetail('1028785', '1234567890');
    console.log('源商品:', sourceDetail.spuName);

    // 2. 构建创建数据
    const createData = targetClient.tenant.buildCreateData(sourceDetail, {
        categoryMapping: { '饮料': '12345' }
    });

    // 3. 自定义修改（例如：调整价格）
    createData.tenantSpu.skus.forEach(sku => {
        // 价格提高10%
        const originalPrice = sku.suggestPrice.tenantSuggestPrice.unifiedSuggestPrice;
        sku.suggestPrice.tenantSuggestPrice.unifiedSuggestPrice = originalPrice * 1.1;
        console.log(`SKU ${sku.spec} 价格调整: ${originalPrice} -> ${originalPrice * 1.1}`);
    });

    // 4. 创建商品到目标后台
    const result = await targetClient.tenant.createProduct(createData);
    
    if (result.success) {
        console.log('商品创建成功');
    } else {
        console.error('商品创建失败:', result.error);
    }
}

// ========== 示例10: 错误处理和重试 ==========
async function example10_ErrorHandling() {
    console.log('\n========== 示例10: 错误处理 ==========');
    
    const client = new QianniuhuaClient({
        cookies: 'your_cookies_here'
    });

    // 商品搬运时的错误处理
    async function transferWithRetry(poiId, spuId, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`尝试搬运商品 (第${i + 1}次)...`);
                
                const result = await client.transfer.transferProduct(poiId, spuId, {
                    categoryMapping: { '饮料': '12345' }
                });

                if (result.success) {
                    console.log('搬运成功');
                    return result;
                } else {
                    console.warn('搬运失败:', result.error);
                    
                    // 如果是"已存在同名商品"错误，不需要重试
                    if (result.error && result.error.includes('已经存在同名商品')) {
                        console.log('商品已存在，跳过');
                        return result;
                    }
                }
            } catch (error) {
                console.error('搬运异常:', error.message);
            }

            // 等待后重试
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.error('搬运失败，已达最大重试次数');
        return { success: false, error: '已达最大重试次数' };
    }

    // 使用
    await transferWithRetry('1028785', '1234567890');
}

// ========== 主函数 ==========
async function main() {
    console.log('牵牛花 API 使用示例');
    console.log('注意: 这些示例需要替换真实的 Cookie 才能运行');
    
    // 取消注释以运行特定示例
    // await example1_BasicQueries();
    // await example2_StockUpdate();
    // await example3_ProductExport();
    // await example4_TenantProducts();
    // await example5_TransferSingleProduct();
    // await example6_BatchTransfer();
    // await example7_CrossAccountTransfer();
    // await example8_TransferAllProducts();
    // await example9_CustomProductCreation();
    // await example10_ErrorHandling();
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

// 导出示例函数供其他文件使用
module.exports = {
    example1_BasicQueries,
    example2_StockUpdate,
    example3_ProductExport,
    example4_TenantProducts,
    example5_TransferSingleProduct,
    example6_BatchTransfer,
    example7_CrossAccountTransfer,
    example8_TransferAllProducts,
    example9_CustomProductCreation,
    example10_ErrorHandling
};

