const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const clientPath = path.join(__dirname, '..', 'lib', 'client.js')
const clientSource = fs.readFileSync(clientPath, 'utf8')

function loadClient(agentPreset, { selectorOpen = false } = {}) {
  const sessionId = 'session-1'
  const listState = { current: sessionId, byId: { [sessionId]: { agentPreset } } }
  const registrations = []
  const definitions = []
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useEffect() {},
    useState(value) { return [selectorOpen && value === false ? true : value, () => {}] },
  }
  let plugin
  let registeredId
  let dictionaries
  const context = {
    module: { exports: {} },
    console,
    document: {
      createElement() { return { dataset: {}, remove() {} } },
      head: { appendChild() {} },
    },
    fetch() { throw new Error('fetch should not run in render-only tests') },
    window: {
      __ModuleLoader__: {
        load(definition) {
          registeredId = definition.id
          plugin = definition.factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected module: ${id}`)
          })
        },
      },
    },
  }
  vm.runInNewContext(clientSource, context, { filename: clientPath })
  assert.equal(registeredId, 'dsh-ally', 'client entry must register itself through ModuleLoader')
  assert.ok(plugin, 'ModuleLoader factory must produce the client plugin')
  const ctx = {
    conversationEvents: { register(definition) { definitions.push(definition); return () => {} } },
    effect(register) { register(); return () => {} },
    locale: { register(namespace, dicts) { dictionaries = { namespace, dicts }; return () => {} } },
    sessions: { list: { getSnapshot: () => listState, subscribe: () => () => {} } },
    slots: {
      inject(_name, register) { return register() },
      register(config, component) { registrations.push({ config, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  return {
    sessionId,
    listState,
    registrations,
    definitions,
    dictionaries,
    inputRight: registrations.find((entry) => entry.config.id === 'ally-harness'),
  }
}

function selectorProps(fixture, running = false) {
  return {
    sessionId: fixture.sessionId,
    t: (key) => key,
    useSessions: (select) => select(fixture.listState),
    useSession: (select) => select({ running }),
  }
}

test('Harness selector is hidden outside the alliance preset', () => {
  const fixture = loadClient('standard')
  assert.equal(fixture.inputRight.component(selectorProps(fixture)), null)
})

test('new-session screen never inherits Harness visibility from a stale prior alliance session', () => {
  const fixture = loadClient('harness-ally')
  fixture.listState.current = undefined
  assert.equal(fixture.inputRight.component(selectorProps(fixture)), null)
})

test('Harness selector is a compact engine chip inside alliance sessions', () => {
  const fixture = loadClient('harness-ally')
  const rendered = fixture.inputRight.component(selectorProps(fixture))
  const trigger = rendered.props.children[0]

  assert.equal(rendered.props.className, 'ally-engine')
  assert.equal(trigger.props.className, 'ally-engine-trigger')
  assert.equal(trigger.props.children[0].props.children[0].type, 'svg')
  assert.equal(trigger.props.children[0].props.children[0].props.className, 'ally-engine-trigger-icon')
  assert.equal(trigger.props.children[0].props.children[0].props['aria-label'], 'DeepSeek Harness')
  assert.equal(trigger.props.children[1].props.children[0].props.children[0], 'Harness')
})

test('Harness menu uses brand icons and title-only options', () => {
  const fixture = loadClient('harness-ally', { selectorOpen: true })
  const rendered = fixture.inputRight.component(selectorProps(fixture))
  const popover = rendered.props.children[1]
  const title = popover.props.children[0].props.children[0].props.children[0]
  const options = popover.props.children[1].props.children

  assert.equal(title, 'selector.title')
  assert.deepEqual(options.map((option) => option.props.children[1].props.children[0]), [
    'DeepSeek Harness',
    'Claude Code',
    'Codex',
    'Kimi Code',
  ])
  assert.deepEqual(options.map((option) => option.props.children[0].type), ['svg', 'svg', 'svg', 'svg'])
  assert.deepEqual(options.map((option) => option.props.children[0].props['aria-label']), [
    'DeepSeek Harness',
    'Claude Code',
    'Codex',
    'Kimi Code',
  ])
  assert.equal(options[0].type, 'button')
  assert.deepEqual(options.slice(1).map((option) => option.type), ['div', 'div', 'div'])
  assert.deepEqual(options.slice(1).map((option) => option.props.children[2].props.className), [
    'ally-engine-option-install',
    'ally-engine-option-install',
    'ally-engine-option-install',
  ])
  assert.deepEqual(options.slice(1).map((option) => option.props.children[2].props.children[0]), ['cli.install', 'cli.install', 'cli.install'])
  assert.equal(clientSource.includes('ally-engine-desc'), false)
  assert.equal(clientSource.includes('ally-engine-hint'), false)
  assert.equal(clientSource.includes('selector.hint'), false)
  assert.equal(clientSource.includes('DESCRIPTIONS'), false)
  assert.equal(clientSource.includes('conversation.session.header.tabs.trailing'), false)
  assert.equal(clientSource.includes('ally-cli-tag'), false)
})

test('locale dictionaries use the flat key contract expected by the Client locale service', () => {
  const fixture = loadClient('harness-ally')
  assert.equal(fixture.dictionaries.namespace, 'ally')
  assert.equal(fixture.dictionaries.dicts.zh['selector.label'], '运行 Harness')
  assert.equal(fixture.dictionaries.dicts.zh['selector.title'], '选择Harness')
  assert.equal(fixture.dictionaries.dicts.en['selector.label'], 'Execution Harness')
  assert.equal(fixture.dictionaries.dicts.zh.selector, undefined)
})

test('Harness selector locks while the Agent owns a turn', () => {
  const fixture = loadClient('harness-ally')
  const rendered = fixture.inputRight.component(selectorProps(fixture, true))
  const trigger = rendered.props.children[0]

  assert.equal(trigger.props.disabled, true)
})

test('plugin never replaces the native composer or its configured-model selector', () => {
  const fixture = loadClient('harness-ally')

  assert.equal(fixture.registrations.some((entry) => entry.config.name === 'conversation.composer'), false)
  assert.equal(fixture.registrations.some((entry) => entry.config.name === 'conversation.view'), false)
})

test('badges use an additive assistant action without claiming the exclusive turn-tail chain', () => {
  const fixture = loadClient('harness-ally')
  const badge = fixture.registrations.find((entry) => entry.config.id === 'ally-badge')

  assert.equal(fixture.definitions.length, 0)
  assert.equal(clientSource.includes('ally/dispatch'), false)
  assert.equal(fixture.registrations.some((entry) => entry.config.name === 'conversation.chat.turnTail'), false)
  assert.equal(badge.config.name, 'conversation.chat.assistant-actions')
  assert.equal(clientSource.includes("node.kind === 'assistant-step'"), true)
  assert.equal(clientSource.includes('node.data?.finalNode?.messageId'), true)
})
