#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Exports the PNG versions of the artwork in assets/ (needs rsvg-convert from librsvg).
set -e
cd "$(dirname "$0")/../assets"
rsvg-convert -w 1280 banner.svg -o banner.png
rsvg-convert -w 1280 social-preview.svg -o social-preview.png
rsvg-convert -w 512 icon.svg -o icon-512.png
rsvg-convert -w 180 icon.svg -o apple-touch-icon.png
echo "exported banner.png, social-preview.png, icon-512.png, apple-touch-icon.png"
