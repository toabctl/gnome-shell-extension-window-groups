# Tier 1 and 2: pure units and the fake shell. No GNOME, no VM, ~1s.
# Tier 3 and 4 need a compositor; see run-nested.sh and run-lxd.sh.

UNITS := model.test.mjs layouts.test.mjs search.test.mjs arranger.test.mjs
SOURCES := extension.js prefs.js layouts.js search.js model.js arranger.js

.PHONY: check test mutants lint schema integration vm-sync clean

## Everything that runs without a compositor.
check: lint schema test mutants

test:
	@node --test $(UNITS)

## A green suite proves nothing until it can fail. Every mutant must be killed.
mutants:
	@node mutants.mjs

lint:
	@for f in $(SOURCES); do node --check "$$f" >/dev/null || exit 1; done
	@python3 -c "import ast,sys; [ast.parse(open(f).read()) for f in \
	  ('screenshot-helper.py','guest-input.py','guest-display.py')]"
	@bash -n run-nested.sh && bash -n run-lxd.sh && bash -n screenshot.sh \
	  && bash -n integration-test.sh && bash -n lib-sandbox.sh
	@echo "lint ok"

## The extension is nothing without a valid schema; catch a bad edit here
## rather than as a silent settings failure inside the shell.
schema:
	@glib-compile-schemas --strict --dry-run schemas/
	@echo "schema ok"

## Tier 3: assertions against a real shell in the VM. Needs the VM up.
integration:
	@./run-lxd.sh sync
	@./integration-test.sh

vm-sync:
	@./run-lxd.sh sync

clean:
	@rm -rf .sandbox .sandbox-headless shot.png vm-shot.png
