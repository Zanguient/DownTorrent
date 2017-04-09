#!/bin/bash

#VARS
CONFIG_FILE="/usr/src/app/backend/start.config.json"
USER=$1

#Add user to system
docker-compose exec --privileged downtorrent_back_prod adduser --shell /bin/bash --disabled-password --gecos "" $USER

#Make user home
docker-compose exec --privileged downtorrent_back_prod mkdir "/home/$USER/downloads"

#Create user folder for downloads
docker-compose exec --privileged downtorrent_back_prod chmod -R 0777 "/home/$USER/downloads"
docker-compose exec --privileged downtorrent_back_prod chown $USER:$USER  -R "/home/$USER/downloads"

#Add user to config file
docker-compose exec --privileged downtorrent_back_prod sed -i 's/\("VALID_USERS":\s\[.*\)\]\,/\1\,"'"$USER"'"],/g' "$CONFIG_FILE"
docker-compose exec --privileged downtorrent_back_prod cat "$CONFIG_FILE"

# Restart service
docker-compose exec --privileged downtorrent_back_prod sh restart.sh
