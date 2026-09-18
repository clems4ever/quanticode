# quanticode — measurable perspectives on a codebase. One lens so far: heat.
#
# `make run REPO=/path/to/clone` is the short path from a clean checkout to a
# browser; everything else is what CI runs.

GO      ?= go
NPM     ?= npm
ADDR    ?= :8090
REPO    ?=
WEB_DIR := web/dist

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install frontend dependencies
	cd web && $(NPM) install

.PHONY: build
build: build-web build-go ## Build the frontend and the server

.PHONY: build-web
build-web: ## Build the frontend into web/dist
	cd web && $(NPM) run build

.PHONY: build-go
build-go: ## Build the server binary
	$(GO) build -o quanticode ./cmd/quanticode

.PHONY: test
test: test-go test-web ## Run every test

.PHONY: test-go
test-go: ## Run the Go tests with the race detector
	$(GO) test ./... -race -count=1

.PHONY: test-web
test-web: ## Run the frontend tests, including the colour-ramp gate
	cd web && $(NPM) test

.PHONY: lint
lint: ## Run every static check CI runs
	@unformatted=$$(gofmt -l .); \
		if [ -n "$$unformatted" ]; then echo "needs gofmt:"; echo "$$unformatted"; exit 1; fi
	$(GO) vet ./...
	cd web && $(NPM) run lint && $(NPM) run typecheck

.PHONY: run
run: build ## Build, then serve REPO=/path/to/clone on ADDR
	@test -n "$(REPO)" || (echo "usage: make run REPO=/path/to/a/git/clone" && exit 1)
	./quanticode -addr $(ADDR) -repo $(REPO) -web $(WEB_DIR)

.PHONY: clean
clean: ## Remove build output
	rm -rf quanticode quanticode-server $(WEB_DIR) coverage.out web/*.tsbuildinfo
