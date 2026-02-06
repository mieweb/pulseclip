#!/bin/bash
# Check if MYNAME is defined in server/.env, which indicates production mode

ENV_FILE="server/.env"

if [ -f "$ENV_FILE" ]; then
  MYNAME=$(grep "^MYNAME=" "$ENV_FILE" | cut -d'=' -f2-)
  if [ -n "$MYNAME" ]; then
    echo ""
    echo "⚠️  WARNING: MYNAME is defined in server/.env"
    printf "   MYNAME=%s\n" "$MYNAME"
    echo ""
    echo "   This indicates a production/proxy environment."
    echo "   You should use 'npm run prod' instead of 'npm run dev'."
    echo ""
    echo "   To run in dev mode anyway, remove or comment out MYNAME in server/.env"
    echo ""
    exit 1
  fi
fi

# No MYNAME found, proceed with dev mode
exit 0
