SHELL   := /bin/bash
NVM_DIR ?= $(HOME)/.nvm

# Activate Node 22 (required by dkg CLI) in a single recipe line.
# Fails loudly if nvm or v22 is not installed.
NVM22 := source "$(NVM_DIR)/nvm.sh" 2>/dev/null && nvm use 22 --silent &&

NODE1_HOME    := $(HOME)/.dkg
NODE2_HOME    := $(HOME)/.dkg2
NODE1_PORT    := 9200
NODE2_PORT    := 9201
NODE2_OXI_PORT := 7879  # node1 uses the default 7878; node2 needs a different port

.DEFAULT_GOAL := help
.PHONY: build dev install deploy deploy-no-build test lint format \
        node1-init node1-start node1-stop node1-token node1-logs node1-reset \
        node2-init node2-start node2-stop node2-token node2-logs node2-reset \
        status help

# ── Help ───────────────────────────────────────────────────────────────────────

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Plugin"
	@echo "  install          Install into a vault: make install VAULT=\"/path/to/vault\""
	@echo "  build            Type-check + production build"
	@echo "  dev              esbuild watch (rebuilds on save)"
	@echo "  deploy           Build + copy plugin into DKG-testing* vaults"
	@echo "  deploy-no-build  Copy existing build artifacts (skip rebuild)"
	@echo "  test             Run Vitest suite"
	@echo "  lint             Run ESLint"
	@echo "  format           Run Prettier (writes files)"
	@echo ""
	@echo "Node 1  (localhost:$(NODE1_PORT), DKG_HOME=$(NODE1_HOME))"
	@echo "  node1-init       Interactive first-time setup for node 1"
	@echo "  node1-start      Start node 1 daemon"
	@echo "  node1-stop       Stop node 1 daemon"
	@echo "  node1-token      Print node 1 auth token"
	@echo "  node1-reset      !! Wipe all node 1 data and stop daemon"
	@echo ""
	@echo "Node 2  (localhost:$(NODE2_PORT), DKG_HOME=$(NODE2_HOME))"
	@echo "  node2-init       Interactive first-time setup for node 2"
	@echo "  node2-start      Start node 2 daemon (port set during init)"
	@echo "  node2-stop       Stop node 2 daemon"
	@echo "  node2-token      Print node 2 auth token"
	@echo "  node2-reset      !! Wipe all node 2 data and stop daemon"
	@echo ""
	@echo "  status           Show live status of both nodes"

# ── Plugin ─────────────────────────────────────────────────────────────────────

# One-command install for users: copy the committed build (main.js, manifest.json,
# styles.css) into a vault. No build/Node needed — the artifacts ship in the repo.
#   make install VAULT="/path/to/your vault"
install:
	@[ -n "$(VAULT)" ] || { echo 'Usage: make install VAULT="/path/to/your vault"'; exit 1; }
	@bash scripts/deploy-to-vault.sh --no-build --no-hotreload "$(VAULT)"

build:
	$(NVM22) pnpm build

dev:
	$(NVM22) pnpm dev

deploy:
	$(NVM22) pnpm deploy

deploy-no-build:
	$(NVM22) bash scripts/deploy-to-vault.sh --no-build

test:
	$(NVM22) pnpm test

lint:
	$(NVM22) pnpm lint

format:
	$(NVM22) pnpm format

# ── DKG node 1 ─────────────────────────────────────────────────────────────────

node1-init:
	$(NVM22) DKG_HOME="$(NODE1_HOME)" dkg init --role edge --store oxigraph-server

node1-start:
	$(NVM22) DKG_HOME="$(NODE1_HOME)" dkg start
	@echo "Node 1 started on port $(NODE1_PORT)"

node1-stop:
	$(NVM22) DKG_HOME="$(NODE1_HOME)" dkg stop

node1-token:
	$(NVM22) DKG_HOME="$(NODE1_HOME)" dkg auth show

node1-reset:
	@echo "Stopping node 1…"
	-$(NVM22) DKG_HOME="$(NODE1_HOME)" dkg stop 2>/dev/null
	rm -rf "$(NODE1_HOME)"
	@echo "Node 1 data wiped. Run 'make node1-init' to reinitialize."

# ── DKG node 2 ─────────────────────────────────────────────────────────────────

node2-init:
	$(NVM22) DKG_HOME="$(NODE2_HOME)" dkg init --role edge --store oxigraph-server
	jq '.store.options.port = $(NODE2_OXI_PORT)' "$(NODE2_HOME)/config.json" > "$(NODE2_HOME)/config.json.tmp" \
	  && mv "$(NODE2_HOME)/config.json.tmp" "$(NODE2_HOME)/config.json"
	@echo "Oxigraph port set to $(NODE2_OXI_PORT) in node2 config."

node2-start:
	$(NVM22) DKG_HOME="$(NODE2_HOME)" dkg start
	@echo "Node 2 started (port set at init time)"

node2-stop:
	$(NVM22) DKG_HOME="$(NODE2_HOME)" dkg stop

node2-token:
	$(NVM22) DKG_HOME="$(NODE2_HOME)" dkg auth show

node2-reset:
	@echo "Stopping node 2…"
	-$(NVM22) DKG_HOME="$(NODE2_HOME)" dkg stop 2>/dev/null
	rm -rf "$(NODE2_HOME)"
	@echo "Node 2 data wiped. Run 'make node2-init' to reinitialize."

# ── Status ─────────────────────────────────────────────────────────────────────

status:
	@echo "=== Node 1 (port $(NODE1_PORT)) ==="
	@curl -sf http://localhost:$(NODE1_PORT)/api/status \
	  | jq '{name,version,nodeRole,peerId}' 2>/dev/null \
	  || echo "  (offline)"
	@echo "=== Node 2 (port $(NODE2_PORT)) ==="
	@curl -sf http://localhost:$(NODE2_PORT)/api/status \
	  | jq '{name,version,nodeRole,peerId}' 2>/dev/null \
	  || echo "  (offline)"
