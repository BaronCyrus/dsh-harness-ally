export function createAsyncQueue() {
  const values = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else values.push(value)
    },
    end() {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() { return this },
    next() {
      if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false })
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}
