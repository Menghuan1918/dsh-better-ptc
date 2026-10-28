# dsh-better-ptc

Shared host service for DeepSeek Harness PTC run_code deadline exemptions.

## What it does

The Node PTC runtime owns the run_code elapsed deadline. This package is a
singleton host row that patches the mounted runtime prototype's run once and
exposes ctx.betterPtc.register(toolName). While a registered tool's binding is
in flight the wall clock pauses; when it returns the remaining budget resumes.
Other bindings still consume the program budget. The wrapper reports its own
expiry as the runtime's normal timeout failure and preserves outer aborts.

## Stable row

The row id and name are both dsh-better-ptc. Every plugin that needs an
exemption inserts the same row in its bundle patch; the DSH Loader deduplicates
by row id, so installing several plugins (or the shared bundle itself) still
activates exactly one row and one service. Plugins call the service through
ctx.inject(['betterPtc'], ...); they do not import private copies.

## API

ctx.betterPtc.register(toolName) returns an idempotent unregister disposer.
The call is refcounted per tool name. If the mounted runtime has no numeric
timeout (for example the experimental Python provider), registration is a
no-op. The service never edits DSH core.

## Install

The package is a host-only bundle. Install it directly to mount the service, or
let a plugin's bundle patch insert the stable row:

~~~sh
dsh plugin --profile <profile> add dsh-better-ptc
~~~

## Development

~~~sh
npm install
npm test
~~~

The unit tests exercise the pure createRuntimeExemption registry with a fake
runtime. A live check can mount the real installed NodePtcRuntime and verify
that both a registered wait and an unregistered normal binding keep their
expected timeout behavior.
