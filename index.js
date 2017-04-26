'use strict'

const now = require('observe-now')
const concurrent = require('concurrent-task')

const token = process.env.NOW_TOKEN
const nowTs = +new Date()

const getDeployments = () => new Promise ((resolve, reject) => {
  const tasks = []
  const get = now.get('list', token, 'deployments.*')
    .on('response', deployment => {
      if (!deployment || !deployment.url) { return }
      deployment.id = String(deployment.uid)
      delete deployment.uid

      tasks.push(deployment)
    })
    .on('error', error => {
      get.abort()
      reject(error)
    })
    .on('end', () => {
      console.log('%d deployments found', Object.keys(tasks).length)

      get.set(null)
      resolve(tasks)
    })
    .send()
})

const getDetails = tasks => new Promise(resolve => {
  const runner = concurrent([
    {
      timeout: 3 * 1000,
      tryCount: 5,
      run (dep, resolve, reject) {
        const apiPath = `deployments/${dep.id}`

        const get = now.get(apiPath, token, false)
          .on('response', depInfo => {
            if (depInfo && depInfo.state) {
              resolve({ [dep.id]: depInfo })
            }
          })
          .on('error', error => {
            reject(Object.assign(error, { apiPath }))
          })
          .on('end', () => {
            resolve()
            get.set(null)
          })
          .send()

        return get.abort.bind(get)
      }
    },
    {
      timeout: 5 * 1000,
      tryCount: 5,
      run (dep, resolve, reject) {
        dep = runner.results(dep.id)

        if (
          dep.state &&
          dep.stateTs &&
          ~['DEPLOYMENT_ERROR', 'FROZEN'].indexOf(dep.state) &&
          (nowTs - +new Date(dep.stateTs)) >= 100 * 86400 * 1000
        ) {
          console.log('Removing:', dep.uid, dep.host, dep.state, dep.stateTs)

          now.update('DELETE', `deployments/${dep.uid}`)
            .then(res => resolve({ removed: { [dep.uid]: {
              host: dep.host,
              state: dep.state,
              stateTs: dep.stateTs
            } } }))
            .catch(reject)
        } else {
          resolve()
        }
      }
    }
  ])

  runner.addTask(tasks)

  runner
    .on('error', (dep, error) => {
      console.error('ERROR at deployment %j, %j', dep, error)
    })
    .on('complete', () => {
      resolve(runner.results('removed'))
      runner.set(null)
    })
    .run(10)
})

getDeployments()
  .then(getDetails)
  .then(removed => {
    console.log('%d deployments removed.', Object.keys(removed).length)
  })
  .catch(error => {
    console.error(error && error.stack)
  })
