# Android APK 构建指南

## 概述
本项目已配置为使用 Capacitor 将 Claude Code UI 打包为 Android APK，连接远程服务器 `https://code.zaneleo.top`。

**当前版本**: 1.15.0

## 新功能: 多客户端集群支持

Android 应用现在支持连接到多个远程客户端（Slave），用户可以在应用内切换不同的客户端：

- 在侧边栏顶部有客户端选择器
- 选择不同客户端后，所有操作（项目浏览、聊天、终端）都会路由到对应的客户端
- 客户端选择会保存到 localStorage，下次打开自动恢复

## 环境要求
- Node.js 20+
- Android Studio（含 Android SDK）
- JDK 17+
- Gradle（Android Studio 自带）

## 文件结构
```
claudecodeui/
├── capacitor.config.ts        # Capacitor 配置
├── android/                   # Android 原生项目
│   ├── app/
│   │   ├── build.gradle       # 应用构建配置（含签名配置）
│   │   └── src/main/
│   │       ├── AndroidManifest.xml    # 权限和 Deep Link 配置
│   │       └── res/xml/
│   │           └── network_security_config.xml  # 网络安全配置
│   └── keystore.properties.template   # 签名配置模板
├── src/utils/
│   ├── api.js                 # API 配置（支持 Capacitor + 集群）
│   └── websocket.js           # WebSocket 配置（支持 Capacitor + 集群）
├── src/components/
│   ├── Shell.jsx              # Shell WebSocket（支持 Capacitor + 集群）
│   └── ClientSelector.jsx     # 客户端选择器组件
├── src/contexts/
│   └── ClusterContext.jsx     # 集群状态管理
└── public/
    └── sw.js                  # Service Worker（增强缓存策略）
```

## 构建步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 构建 Web 资源并同步
```bash
npm run cap:build
```

### 3. 生成签名密钥（首次构建）
```bash
cd android
keytool -genkey -v -keystore release-key.keystore \
  -alias claudeui -keyalg RSA -keysize 2048 -validity 10000
```

### 4. 配置签名
复制模板文件并填写密钥信息：
```bash
cp android/keystore.properties.template android/keystore.properties
```

编辑 `android/keystore.properties`：
```properties
storeFile=release-key.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=claudeui
keyPassword=YOUR_KEY_PASSWORD
```

### 5. 构建 Debug APK
```bash
npm run android:debug
```
输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`

### 6. 构建 Release APK
```bash
npm run android:release
```
输出位置：`android/app/build/outputs/apk/release/app-release.apk`

### 7. 构建 AAB（用于 Play Store）
```bash
npm run android:bundle
```
输出位置：`android/app/build/outputs/bundle/release/app-release.aab`

## 使用 Android Studio

### 打开项目
```bash
npx cap open android
```

### 在 Android Studio 中
1. 等待 Gradle 同步完成
2. 选择设备或模拟器
3. 点击 Run 按钮

## NPM 脚本说明

| 脚本 | 说明 |
|------|------|
| `npm run cap:sync` | 同步 Web 资源到 Android |
| `npm run cap:open` | 在 Android Studio 中打开项目 |
| `npm run cap:build` | 构建 Web 并同步到 Android |
| `npm run android:debug` | 构建 Debug APK |
| `npm run android:release` | 构建 Release APK |
| `npm run android:bundle` | 构建 AAB |

## 功能特性

### Capacitor 环境检测
应用会自动检测是否运行在 Capacitor 环境中：
- **Web 环境**: 使用相对 URL 连接本地服务器
- **Capacitor 环境**: 使用完整 URL 连接 `https://code.zaneleo.top`

### 集群客户端选择
在 Capacitor 环境中，应用支持多客户端切换：
- API 请求自动添加 `X-Target-Slave` header
- WebSocket 连接自动添加 `_slave` 查询参数
- 客户端选择保存在 `localStorage` 的 `cluster-selected-client` 键

### Service Worker 缓存策略
- **静态资源**: 缓存优先，后台更新
- **API 请求**: 网络优先，离线返回错误
- **导航请求**: 离线时返回缓存的 index.html

### 网络配置
- 仅允许 HTTPS 连接
- 允许连接到 `code.zaneleo.top`
- WebSocket 使用 WSS 协议

### Deep Link 支持
- `claudeui://` 自定义协议
- `https://code.zaneleo.top` App Link

## 服务器端 CORS 配置

如果遇到 CORS 问题，需要在服务器端添加以下配置：

```javascript
const corsOptions = {
  origin: [
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost'
  ],
  credentials: true
};
app.use(cors(corsOptions));
```

对于 WebSocket，确保允许来自 Capacitor 的连接：
```javascript
wss.on('connection', (ws, req) => {
  // 验证 origin
  const origin = req.headers.origin;
  const allowedOrigins = [
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost'
  ];
  // ...
});
```

## 故障排除

### 网络连接失败
1. 检查设备网络连接
2. 确认服务器 CORS 配置正确
3. 查看 Android Studio Logcat 日志

### 构建失败
1. 确保 Android SDK 已安装
2. 检查 JDK 版本 (需要 17+)
3. 运行 `npx cap sync android` 重新同步

### Service Worker 不工作
1. 清除应用数据
2. 重新安装应用
3. 检查浏览器控制台日志

## 版本更新

更新应用版本：
1. 编辑 `android/app/build.gradle`：
   ```gradle
   versionCode 3
   versionName "1.16.0"
   ```
2. 同时更新 `package.json` 的 version 字段
3. 重新构建 APK

## 版本历史

| 版本 | versionCode | 更新内容 |
|------|-------------|----------|
| 1.15.0 | 2 | 添加多客户端集群支持 |
| 1.0 | 1 | 初始版本 |

## 更新图标

运行图标生成脚本：
```bash
node generate-android-icons.js
```
然后重新同步：
```bash
npx cap sync android
```
