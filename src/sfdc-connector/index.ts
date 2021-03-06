import { Config, MetaObj, AuraObj, LwcObj, AuraBundle } from '../fast-sfdc'
import * as SfdcConn from 'node-salesforce-connection'
import configService from '../services/config-service'
import utils from '../utils/utils'
import soapWithDebug from './soap-with-debug'
import logger from '../logger'

let config = configService.getConfigSync()
let apiVersion: string
const conn = new SfdcConn()

const connect = async function (cfg?: Config) {
  if (cfg) config = cfg
  const creds = config.credentials[config.currentCredential]
  apiVersion = await configService.getPackageXmlVersion()
  await conn.soapLogin({
    hostname: creds.url,
    apiVersion,
    username: creds.username,
    password: creds.password
  })
}

const getBasePath = () => `/services/data/v${apiVersion}/tooling`
const rest = async function (endpoint: string, ...args: any[]) {
  try {
    if (!conn.sessionId) await connect()
    return await conn.rest(getBasePath() + endpoint, ...args)
  } catch (e) {
    if (e.code === 'ENOTFOUND') throw Error('Unreachable host. Check connection')
    else if (e.response && (e.response.statusCode === 401 || e.response.statusCode === 403)) {
      await connect()
      return conn.rest(getBasePath() + endpoint, ...args)
    } else {
      throw e
    }
  }
}

const metadata = async function (method: string, args: any, wsdl = 'Metadata', headers: any = {}) {
  const metadataWsdl = conn.wsdl(apiVersion, wsdl)
  try {
    if (!conn.sessionId) await connect()
    return await soapWithDebug(conn, metadataWsdl, method, args, headers)
  } catch (e) {
    if (e.code === 'ENOTFOUND') throw Error('Unreachable host. Check connection')
    else if (e.response && (e.response.statusCode === 401 || e.response.statusCode === 403)) {
      await connect()
      return soapWithDebug(conn, metadataWsdl, method, args, headers)
    } else {
      throw e
    }
  }
}

const post = async (endpoint: string, body: any) => rest(endpoint, { method: 'POST', body })
const patch = async (endpoint: string, body: any) => rest(endpoint, { method: 'PATCH', body })
const del = async (endpoint: string) => rest(endpoint, { method: 'DELETE' })
const get = async (endpoint: string) => rest(endpoint)
const query = (q: string) => get(`/query?q=${encodeURIComponent(q.replace(/ +/g, ' '))}`)

export default {
  connect,
  query,
  metadata,

  async createMetadataContainer (name: string): Promise<string> {
    const old = await query(`SELECT Id FROM MetadataContainer WHERE Name = '${name}'`)
    if (old.records.length) await this.deleteObj('MetadataContainer', old.records[0].Id)
    return (await post('/sobjects/MetadataContainer/', { name })).id
  },

  async runTestSync (tests: any[]): Promise<any> {
    return (post('/runTestsSynchronous', { tests }))
  },

  async upsertObj (toolingType: string, record: MetaObj | AuraObj | LwcObj | AuraBundle) {
    return (record.Id ? this.editObj : this.createObj)(toolingType, record)
  },

  async createObj (toolingType: string, record: MetaObj | AuraObj | LwcObj | AuraBundle) {
    return (await post(`/sobjects/${toolingType}`, record)).id
  },

  async deleteObj (toolingType: string, recordId: string) {
    return del(`/sobjects/${toolingType}/${recordId}`)
  },

  async editObj (toolingType: string, record: MetaObj | AuraObj | LwcObj | AuraBundle) {
    await patch(`/sobjects/${toolingType}/${record.Id}`, {
      ...record,
      Id: undefined,
      MetadataContainerId: undefined,
      AuraDefinitionBundleId: undefined
    })
    return record.Id
  },

  upsertAuraObj: async (record: AuraObj) => exports.default.upsertObj('AuraDefinition', record),

  upsertLwcObj: async (record: any) => exports.default.upsertObj('LightningComponentResource', record),

  async createContainerAsyncRequest (metaContainerId: string): Promise<string> {
    return (await post('/sobjects/ContainerAsyncRequest/', {
      MetadataContainerId: metaContainerId,
      IsCheckOnly: false,
      IsRunTests: false
    })).id
  },

  async pollDeploymentStatus (containerAsyncRequestId: string) {
    let retryCount = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await utils.sleep(retryCount++ > 3 ? 1000 : 200)
      const res = await query(`SELECT
        Id,
        State,
        DeployDetails,
        ErrorMsg
        FROM ContainerAsyncRequest
        WHERE Id = '${containerAsyncRequestId}'`
      )
      if (res.records[0].State !== 'Queued') return res.records[0]
      logger.appendLine('Polling...')
    }
  },

  findAuraByNameAndDefType: async (
    bundleName: string,
    auraDefType: string
  ): Promise<AuraObj> => (await query(`SELECT
    Id,
    AuraDefinitionBundleId
    FROM AuraDefinition
    WHERE AuraDefinitionBundle.DeveloperName = '${bundleName}'
    AND DefType = '${auraDefType}'
  `)).records[0],

  findLwcByNameAndDefType: async (
    bundleName: string,
    lwcDefType: string,
    filePath: string | undefined = undefined
  ): Promise<any> => (await query(`SELECT
    Id
    FROM LightningComponentResource
    WHERE LightningComponentBundle.DeveloperName = '${bundleName}'
    AND Format = '${lwcDefType}'
    ${filePath ? ` AND FilePath = '${filePath}'` : ''}
  `)).records[0],

  findLwcBundleId: async (
    bundleName: string
  ): Promise<any> => (await query(`SELECT
    Id
    FROM LightningComponentBundle
    WHERE DeveloperName = '${bundleName}'
  `)).records[0].Id,

  executeAnonymous: (scriptData: string) => metadata('executeAnonymous', {
    String: scriptData
  }, 'Apex', {
    headers: {
      DebuggingHeader: {
        categories: {
          category: 'Apex_code',
          level: 'FINEST'
        },
        debugLevel: 'DETAIL'
      }
    }
  })
}
