#!/usr/bin/env node
/**
 * Generate Android app icons from source logo
 * Requires: sharp (npm install sharp)
 * Usage: node generate-android-icons.js
 */

import sharp from 'sharp';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_ICON = join(__dirname, 'public/logo-512.png');
const ANDROID_RES = join(__dirname, 'android/app/src/main/res');

// Android icon sizes (in pixels)
const ICON_SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

// Foreground icon sizes (adaptive icons use 108dp with safe zone)
const FOREGROUND_SIZES = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432,
};

async function generateIcons() {
  console.log('Generating Android icons from:', SOURCE_ICON);

  for (const [folder, size] of Object.entries(ICON_SIZES)) {
    const outputDir = join(ANDROID_RES, folder);

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Generate regular launcher icon
    const iconPath = join(outputDir, 'ic_launcher.png');
    await sharp(SOURCE_ICON)
      .resize(size, size)
      .png()
      .toFile(iconPath);
    console.log(`Created: ${iconPath} (${size}x${size})`);

    // Generate round launcher icon
    const roundIconPath = join(outputDir, 'ic_launcher_round.png');
    const roundSize = size;
    const circleBuffer = Buffer.from(
      `<svg width="${roundSize}" height="${roundSize}">
        <circle cx="${roundSize/2}" cy="${roundSize/2}" r="${roundSize/2}" fill="white"/>
      </svg>`
    );

    await sharp(SOURCE_ICON)
      .resize(roundSize, roundSize)
      .composite([{
        input: circleBuffer,
        blend: 'dest-in'
      }])
      .png()
      .toFile(roundIconPath);
    console.log(`Created: ${roundIconPath} (${roundSize}x${roundSize})`);
  }

  // Generate foreground icons for adaptive icons
  for (const [folder, size] of Object.entries(FOREGROUND_SIZES)) {
    const outputDir = join(ANDROID_RES, folder);
    const foregroundPath = join(outputDir, 'ic_launcher_foreground.png');

    // Create a larger canvas with padding for adaptive icon safe zone
    const iconSize = Math.round(size * 0.66); // Icon takes 66% of the foreground
    const padding = Math.round((size - iconSize) / 2);

    await sharp(SOURCE_ICON)
      .resize(iconSize, iconSize)
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(foregroundPath);
    console.log(`Created: ${foregroundPath} (${size}x${size})`);
  }

  console.log('\nAndroid icons generated successfully!');
}

generateIcons().catch(console.error);
