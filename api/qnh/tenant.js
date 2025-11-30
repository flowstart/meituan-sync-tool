/**
 * 牵牛花 API - 租户商品管理模块
 * 负责：租户级别商品查询、商品创建、商品入档
 */

class TenantModule {
    /**
     * 构造函数
     * @param {QNHBaseClient} baseClient - 基础客户端实例
     */
    constructor(baseClient) {
        this.base = baseClient;
    }

    /**
     * 查询租户商品列表（分页）
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @param {Object} filters - 过滤条件（可选）
     * @returns {Promise<Object>} 商品列表数据
     */
    async getProducts(page = 1, pageSize = 20, filters = {}) {
        const url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/page-query';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const data = {
            labelInfoList: filters.labelInfoList || [],
            channelCategory: {
                channelId: filters.channelId || 100,
                categoryProperty: filters.categoryProperty || {}
            },
            page: page,
            pageSize: pageSize,
            backendCategoryList: filters.backendCategoryList || [],
            ...filters
        };

        console.log(`[QNH Tenant] 查询租户商品: page=${page}, pageSize=${pageSize}`);

        const result = await this.base.request('POST', fullUrl, data);
        return result.data || {};
    }

    /**
     * 查询租户商品详情（SPU信息）
     * @param {string} spuId - 商品SPU ID
     * @returns {Promise<Object>} 商品详情
     */
    async getProductInfo(spuId) {
        const url = 'https://qnh.meituan.com/api/v1/tenant/spu/querySpuInfo';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const data = {
            spu: spuId
        };

        console.log(`[QNH Tenant] 查询商品详情: spuId=${spuId}`);

        const result = await this.base.request('POST', fullUrl, data);
        return result.data || {};
    }

    /**
     * 创建商品（入档到租户）
     * @param {Object} productData - 商品数据
     * @returns {Promise<Object>} 创建结果
     */
    async createProduct(productData) {
        const url = 'https://qnh.meituan.com/qnh-gw3/api/product/tenant/create';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        console.log(`[QNH Tenant] 创建商品: ${productData.tenantSpu?.spuName || '未知商品'}`);

        try {
            const result = await this.base.request('POST', fullUrl, productData);
            console.log(`[QNH Tenant] 商品创建成功`);
            return {
                success: true,
                data: result.data
            };
        } catch (error) {
            console.error(`[QNH Tenant] 商品创建失败: ${error.message}`);
            
            // 检查是否是组合品错误，尝试修复
            if (error.message.includes('商品类型为组合品，子商品列表不能为空')) {
                console.warn('[QNH Tenant] 检测到组合品错误，尝试将所有SKU改为单品类型');
                
                const fixedData = JSON.parse(JSON.stringify(productData));
                if (fixedData.tenantSpu && fixedData.tenantSpu.skus) {
                    fixedData.tenantSpu.skus.forEach(sku => {
                        sku.skuSaleType = 1;
                    });
                }
                
                try {
                    const retryResult = await this.base.request('POST', fullUrl, fixedData);
                    console.log(`[QNH Tenant] 修复后创建成功`);
                    return {
                        success: true,
                        data: retryResult.data,
                        fixed: true
                    };
                } catch (retryError) {
                    return {
                        success: false,
                        error: retryError.message
                    };
                }
            }
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 构建商品创建数据（从门店商品详情转换为租户商品格式）
     * @param {Object} storeProductDetail - 门店商品详情
     * @param {Object} options - 选项
     *   - categoryMapping: 分类映射 {旧分类名: 新分类ID}
     * @returns {Object} 租户商品创建数据
     */
    buildCreateData(storeProductDetail, options = {}) {
        const data = storeProductDetail;
        const categoryMapping = options.categoryMapping || {};

        // 提取渠道信息
        const channelSpuList = data.channelSpuList || [];
        if (channelSpuList.length < 2) {
            throw new Error('缺少必要的渠道信息（需要美团和饿了么）');
        }

        const mtList = channelSpuList[0];  // 美团闪购
        const elmList = channelSpuList[1]; // 饿了么

        // 获取分类信息
        const frontCategories = channelSpuList[0]?.frontCategories || [];
        if (frontCategories.length === 0) {
            throw new Error('缺少分类信息');
        }
        const categoryName = frontCategories[0].frontCategoryName;

        // 查找分类映射
        const childCategoryId = categoryMapping[categoryName] || '';

        // 提取SKU信息
        const skus = data.storeSkuList || [];

        // 提取分类ID路径
        const mtCategory = mtList.channelCategory || {};
        const elmCategory = elmList.channelCategory || {};

        const mtIdPath = mtCategory.idPath || '';
        const elmIdPath = elmCategory.idPath || '';

        const mtIdList = mtIdPath.split('>');
        const elmIdList = elmIdPath.split('>');

        // 构建创建数据
        const createData = {
            tenantSpu: {
                tenantId: 0,
                spuName: data.spuName || '',
                description: data.tenantDescription || '无',
                picUrlList: (data.tenantImageUrlList || []).slice(0, 10),
                weightType: 1,
                productPlace: '',
                skus: this._convertSkuData(skus),
                spuChannelInfoList: [
                    {
                        channelId: 100,
                        channelName: '美团闪购',
                        loading: false,
                        value: [
                            mtIdList[0] || '',
                            mtIdList[1] || '',
                            mtIdList[2] || ''
                        ],
                        idPath: mtIdPath,
                        categoryId: mtIdList[2] || '',
                        defaultValue: [],
                        categoryName: mtCategory.categoryName || '',
                        level: 3,
                        parentCategoryId: mtIdList[1] || '',
                        supportSpecType: null,
                        children: null,
                        saleAttrInfoVOList: null,
                        checkUpcStatus: null,
                        upcRequired: 0,
                        resourceType: 1,
                        existedInRetailAndMedicine: null,
                        isExtendCategory: null,
                        medicalDeviceQuaRequirement: 0,
                        namePath: mtCategory.namePath || '',
                        categoryCode: mtIdList[2] || '',
                        categoryCodePath: mtIdPath,
                        categoryNamePath: mtCategory.namePath || '',
                        categoryProperties: this._convertCategoryProperties(mtCategory.channelDynamicInfoVOList || []),
                        afterSaleServiceType: data.mtAfterSaleServiceType || 0,
                        saleAttrList: [],
                        skuPicSetting: null
                    },
                    {
                        channelId: 200,
                        channelName: '饿了么',
                        loading: false,
                        value: [
                            elmIdList[0] || '',
                            elmIdList[1] || '',
                            elmIdList[2] || ''
                        ],
                        idPath: elmIdPath,
                        categoryId: elmCategory.categoryId || '',
                        defaultValue: [],
                        categoryName: elmCategory.categoryName || '',
                        level: 3,
                        parentCategoryId: elmIdList[1] || '',
                        supportSpecType: null,
                        children: null,
                        saleAttrInfoVOList: [
                            {
                                attrId: '168606316',
                                attrName: '规格',
                                imageRelated: false
                            },
                            {
                                attrId: '1627207',
                                attrName: '颜色分类',
                                imageRelated: false
                            }
                        ],
                        checkUpcStatus: null,
                        upcRequired: null,
                        resourceType: 1,
                        existedInRetailAndMedicine: null,
                        isExtendCategory: null,
                        medicalDeviceQuaRequirement: 0,
                        namePath: elmCategory.namePath || '',
                        categoryCode: elmIdList[2] || '',
                        categoryCodePath: elmIdPath,
                        categoryNamePath: elmCategory.namePath || '',
                        categoryProperties: this._convertCategoryProperties(elmCategory.channelDynamicInfoVOList || []),
                        saleAttrList: [],
                        skuPicSetting: null
                    }
                ],
                customizedChannelName: {},
                canCustomizeSpec: null,
                videoInfo: null,
                picContentList: data.pictureContents || [],
                specType: data.specType || 0,
                sellPoint: data.tenantSellPoint || '',
                storeFrontCategoryList: [
                    {
                        groupId: 0,
                        storeCategoryList: [
                            {
                                categoryCode: childCategoryId,
                                name: categoryName
                            }
                        ],
                        auxiliaryStoreCategoryList: []
                    }
                ],
                erpTenantSpuExtend: {
                    fromErp: 1
                },
                specialty: 0,
                properties: [],
                aiRecommendInfo: {
                    aiRecommendSellingPoint: false
                }
            },
            dataType: 1,
            hasAudit: 0,
            hasDraft: 0,
            remark: '/unifiedGoods/tenant/create?'
        };

        return createData;
    }

    /**
     * 转换SKU数据（简化版）
     * @private
     */
    _convertSkuData(skus) {
        const converted = [];

        for (const item of skus) {
            const saleUnit = item.saleUnit || '个';
            let weightForUnit = item.weight || 1;

            // 单位转换：如果是克且>=1000，转为千克
            if (weightForUnit >= 1000 && item.storeWeightUnit === '克(g)') {
                weightForUnit = Math.floor(weightForUnit / 1000);
            }

            const convertedItem = {
                upc: [],
                erpTenantSkuExtend: {
                    tenantSkuErpGoodsRelList: []
                },
                onlineStatus: item.skuErpVO?.onlineStatus || 1,
                weightUnit: item.storeWeightUnit || '克(g)',
                skuSaleType: item.skuSaleType || 1,
                suggestPrice: {
                    tenantSuggestPrice: {
                        unifiedSuggestPrice: item.suggestPrice || 0
                    }
                },
                spec: item.spec || '',
                weightForUnit: weightForUnit,
                cartonMeasureConvertFactorList: item.cartonMeasureConvertFactorList || [
                    {
                        cartonMeasureName: saleUnit,
                        basicUnitConvertFactor: 1
                    }
                ],
                saleUnit: saleUnit,
                upcList: item.upcList || [],
                specName: item.spec || '',
                skuChannelInfoList: [],
                customizeNoUpcCode: item.customizeNoUpcCode || 0
            };

            converted.push(convertedItem);
        }

        return converted;
    }

    /**
     * 转换分类属性（从channelDynamicInfoVOList转为categoryProperties）
     * @private
     */
    _convertCategoryProperties(channelDynamicInfo) {
        const properties = [];

        for (const item of channelDynamicInfo) {
            const property = {
                attrId: item.attrId,
                attrName: item.attrName,
                attrValueType: item.attrValueType,
                characterType: item.characterType,
                maxTextLength: item.maxTextLength,
                isRequired: item.isRequired,
                attrSequence: item.attrSequence,
                attrValueList: item.attrValueList,
                customValue: this._transformCustomValue(item.customValue || []),
                optionList: item.optionList,
                structAttrTemplateList: item.structAttrTemplateList || [],
                originalInputValue: item.originalInputValue
            };

            // 复制recommend字段
            if ('recommend' in item) {
                property.recommend = item.recommend;
            }

            // 特殊处理：商品净重清空
            if (item.attrName && item.attrName.includes('商品净重（kg）')) {
                property.customValue = [{ attrValue: '' }];
            }

            properties.push(property);
        }

        // 替换customValue中的值（匹配attrValueList）
        return this._replaceCustomValues(properties);
    }

    /**
     * 转换customValue结构
     * @private
     */
    _transformCustomValue(customValue) {
        if (!customValue || customValue.length === 0) {
            return customValue;
        }

        const transformed = [];

        for (const item of customValue) {
            const newItem = {};

            if ('attrValue' in item && item.attrValue !== null) {
                newItem.attrValue = this._normalizeValue(item.attrValue);
            }

            if ('attrValueId' in item) {
                newItem.attrValueId = item.attrValueId || null;
            }

            if ('structAttrValueList' in item && item.structAttrValueList) {
                newItem.structAttrValueList = [];
                for (const structItem of item.structAttrValueList) {
                    if (structItem.valueList) {
                        const simplified = {
                            formatType: structItem.formatType || 1,
                            valueList: []
                        };
                        for (const valueGroup of structItem.valueList) {
                            const simplifiedGroup = [];
                            for (const val of valueGroup) {
                                if ('value' in val && val.value !== null) {
                                    val.value = this._normalizeValue(val.value);
                                }
                                simplifiedGroup.push({
                                    sequence: val.sequence,
                                    value: val.value,
                                    optionId: val.optionId || '',
                                    optionValue: val.optionValue || ''
                                });
                            }
                            simplified.valueList.push(simplifiedGroup);
                        }
                        newItem.structAttrValueList.push(simplified);
                    }
                }
            }

            transformed.push(newItem);
        }

        return transformed;
    }

    /**
     * 标准化值（处理数字取整）
     * @private
     */
    _normalizeValue(value) {
        if (typeof value === 'string') {
            // 匹配带单位的数字（如"4.0%vol"）
            const match = value.match(/^([\d.]+)(.*)$/);
            if (match) {
                const numPart = match[1];
                const unitPart = match[2];
                try {
                    const numVal = parseFloat(numPart);
                    if (Number.isInteger(numVal)) {
                        return `${Math.floor(numVal)}${unitPart}`;
                    }
                } catch (e) {
                    return value;
                }
            }
        }

        // 处理纯数字
        try {
            const numVal = parseFloat(value);
            if (Number.isInteger(numVal)) {
                return String(Math.floor(numVal));
            }
            return String(numVal);
        } catch (e) {
            return value;
        }
    }

    /**
     * 替换customValue中的值（匹配attrValueList）
     * @private
     */
    _replaceCustomValues(properties) {
        for (const prop of properties) {
            const customValues = prop.customValue || [];
            const attrValueList = prop.attrValueList || [];

            if (customValues.length === 0 || attrValueList.length === 0) {
                continue;
            }

            const customValueStr = this._getCustomValueStr(customValues[0]);
            if (!customValueStr) {
                continue;
            }

            const matched = this._findMatchingAttrValue(customValueStr, attrValueList);
            if (matched) {
                prop.customValue = [{
                    attrValueId: matched.attrValueId,
                    attrValue: matched.attrValue
                }];
            }
        }

        return properties;
    }

    /**
     * 从customValue中提取字符串值
     * @private
     */
    _getCustomValueStr(customValueItem) {
        if ('attrValue' in customValueItem && customValueItem.attrValue !== null) {
            return customValueItem.attrValue;
        }

        if ('structAttrValueList' in customValueItem && customValueItem.structAttrValueList) {
            const structValue = customValueItem.structAttrValueList;
            if (structValue && structValue[0]?.valueList) {
                const valueGroup = structValue[0].valueList[0];
                const values = valueGroup.map(v => v.value).filter(v => v);
                return values.join('');
            }
        }

        return null;
    }

    /**
     * 在attrValueList中查找匹配项
     * @private
     */
    _findMatchingAttrValue(customValueStr, attrValueList) {
        const normalized = this._normalizeValue(customValueStr);

        for (const attrValue of attrValueList) {
            const attrValueStr = attrValue.attrValue;
            if (!attrValueStr) continue;

            const normalizedAttr = this._normalizeValue(attrValueStr);

            if (normalized === normalizedAttr) {
                return attrValue;
            }

            // 特殊处理：中国 <-> 中国大陆
            if ((normalized === '中国' && normalizedAttr === '中国大陆') ||
                (normalized === '中国大陆' && normalizedAttr === '中国')) {
                return attrValue;
            }
        }

        return null;
    }
}

module.exports = TenantModule;

