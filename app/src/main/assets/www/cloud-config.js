/* Optional production API configuration. Android builds may replace this file at packaging time. */
window.CHRONOS_API_BASE = window.CHRONOS_API_BASE || 'https://chronos-api.dvesiz.workers.dev';
/* 版本号的唯一前端来源：与 AndroidManifest.xml 的 versionName 保持一致。
 * build.sh 打包时会用 manifest 的值覆盖这里，网页版则读这个常量。 */
window.CHRONOS_APP_VERSION = window.CHRONOS_APP_VERSION || "2.7.4";
