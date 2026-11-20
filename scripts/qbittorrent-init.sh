#!/usr/bin/env bash
set -euo pipefail

CONF_DIR="/config/qBittorrent"
CONF_FILE="${CONF_DIR}/qBittorrent.conf"

mkdir -p "${CONF_DIR}"

if [ ! -f "${CONF_FILE}" ]; then
  echo "[CloudVideo] Creating initial qBittorrent.conf for internal Docker subnet auth..."
  cat > "${CONF_FILE}" <<'EOF'
[BitTorrent]
Session\DefaultSavePath=/downloads
Session\Preallocation=false
Session\GlobalMaxRatio=0
Session\ShareLimitAction=Stop

[LegalNotice]
Accepted=true

[Preferences]
Downloads\SavePath=/downloads
Downloads\PreAllocation=false
WebUI\Address=*
WebUI\ServerDomains=*
WebUI\AuthSubnetWhitelistEnabled=true
WebUI\AuthSubnetWhitelist=10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
WebUI\LocalHostAuth=false
WebUI\CSRFProtection=false
WebUI\HostHeaderValidation=false
EOF
else
  echo "[CloudVideo] Ensuring Docker subnet auth & small-disk settings in existing qBittorrent.conf..."
  ensure_key() {
    local section="$1"
    local key="$2"
    local value="$3"
    if ! grep -q "^\[${section}\]" "${CONF_FILE}"; then
      printf '\n[%s]\n%s=%s\n' "${section}" "${key}" "${value}" >> "${CONF_FILE}"
      return
    fi
    if grep -q "^${key//\\/\\\\}=" "${CONF_FILE}"; then
      return
    fi
    awk -v sec="[${section}]" -v line="${key}=${value}" '
      $0 == sec { print; print line; next }
      { print }
    ' "${CONF_FILE}" > "${CONF_FILE}.tmp" && mv "${CONF_FILE}.tmp" "${CONF_FILE}"
  }

  ensure_key "LegalNotice" "Accepted" "true"
  ensure_key "BitTorrent" "Session\DefaultSavePath" "/downloads"
  ensure_key "BitTorrent" "Session\Preallocation" "false"
  ensure_key "Preferences" "Downloads\SavePath" "/downloads"
  ensure_key "Preferences" "Downloads\PreAllocation" "false"
  ensure_key "Preferences" "WebUI\AuthSubnetWhitelistEnabled" "true"
  ensure_key "Preferences" "WebUI\AuthSubnetWhitelist" "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16"
  ensure_key "Preferences" "WebUI\LocalHostAuth" "false"
  ensure_key "Preferences" "WebUI\CSRFProtection" "false"
  ensure_key "Preferences" "WebUI\HostHeaderValidation" "false"
fi

chown -R abc:abc "${CONF_DIR}" 2>/dev/null || true
