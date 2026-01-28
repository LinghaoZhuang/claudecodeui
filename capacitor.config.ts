import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.zaneleo.claudeui',
  appName: 'Claude Code UI',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['https://code.zaneleo.top/*', 'wss://code.zaneleo.top/*']
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#ffffff'
    }
  }
};

export default config;
