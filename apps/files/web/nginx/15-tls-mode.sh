#!/bin/sh
set -eu

common_locations='root /usr/share/nginx/html;
    index index.html;
    client_max_body_size 20g;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src '\''self'\''; img-src '\''self'\'' blob: data:; media-src '\''self'\'' blob:; style-src '\''self'\'' '\''unsafe-inline'\''; script-src '\''self'\''; connect-src '\''self'\'' ws://$host:* wss://$host:*" always;
    location ^~ /api/docs/ { proxy_pass http://files-server; proxy_http_version 1.1; proxy_set_header Host $host; add_header X-Content-Type-Options nosniff always; add_header Referrer-Policy no-referrer always; add_header Content-Security-Policy "default-src '\''self'\''; img-src '\''self'\'' data:; style-src '\''self'\'' '\''unsafe-inline'\''; script-src '\''self'\'' '\''unsafe-inline'\''; connect-src '\''self'\''" always; }
    location /api/ { proxy_pass http://files-server; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; proxy_read_timeout 3600s; proxy_request_buffering off; }
    location / { try_files $uri $uri/ /index.html; }'

if [ "${FILES_APPS_ENABLED:-true}" = "true" ]; then
  common_locations="${common_locations}
    location = /_rfb_app_auth { internal; proxy_pass http://files-server/api/v1/auth/check; proxy_pass_request_body off; proxy_set_header Content-Length \"\"; proxy_set_header Cookie \$http_cookie; }"
fi

if [ "${FILES_APPS_ENABLED:-true}" = "true" ]; then
  common_locations="${common_locations}
    location = /vfx { return 308 /apps/video/; }
    location ^~ /vfx/ { rewrite ^/vfx/(.*)$ /apps/video/\$1 permanent; }
    location = /apps/text { return 308 /apps/text/; }
    location ^~ /apps/text/ { auth_request /_rfb_app_auth; proxy_pass http://text-editor:8080/; proxy_http_version 1.1; proxy_set_header Host \$host; }
    location = /apps/images { return 308 /apps/images/; }
    location ^~ /apps/images/ { auth_request /_rfb_app_auth; proxy_pass http://image-tools:8080/; proxy_http_version 1.1; proxy_set_header Host \$host; }
    location = /apps/video { return 308 /apps/video/; }
    location ^~ /apps/video/ { auth_request /_rfb_app_auth; client_max_body_size 40g; proxy_pass http://video-studio:4317/; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \$connection_upgrade; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 3600s; }"
fi

export HTTP_SERVER_BODY="${common_locations}"
