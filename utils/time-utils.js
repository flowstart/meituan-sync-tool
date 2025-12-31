/**
 * 时间工具函数 - 统一使用本地时间格式
 */

/**
 * 获取本地时间的 ISO 格式字符串（不带 Z 后缀）
 * 格式：2025-12-25T12:03:40
 * @param {Date} date - 日期对象，默认为当前时间
 * @returns {string} 本地时间字符串
 */
function toLocalISOString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * 获取本地日期字符串
 * 格式：2025-12-25
 * @param {Date} date - 日期对象，默认为当前时间
 * @returns {string} 本地日期字符串
 */
function toLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 获取本地时间字符串（仅时间部分）
 * 格式：12:03:40
 * @param {Date} date - 日期对象，默认为当前时间
 * @returns {string} 本地时间字符串
 */
function toLocalTimeString(date = new Date()) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

module.exports = { toLocalISOString, toLocalDateString, toLocalTimeString };

