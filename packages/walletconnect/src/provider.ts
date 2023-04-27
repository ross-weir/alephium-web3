/*
Copyright 2018 - 2022 The Alephium Authors
This file is part of the alephium project.

The library is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

The library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with the library. If not, see <http://www.gnu.org/licenses/>.
*/
import EventEmitter from 'eventemitter3'
import { SessionTypes } from '@walletconnect/types'
import SignClient from '@walletconnect/sign-client'
import { getChainsFromNamespaces, getAccountsFromNamespaces, getSdkError } from '@walletconnect/utils'
import {
  SignerProvider,
  Account,
  SignTransferTxParams,
  SignTransferTxResult,
  SignDeployContractTxParams,
  SignDeployContractTxResult,
  SignExecuteScriptTxParams,
  SignExecuteScriptTxResult,
  SignUnsignedTxParams,
  SignUnsignedTxResult,
  SignMessageParams,
  SignMessageResult,
  groupOfAddress,
  addressFromPublicKey,
  NodeProvider,
  ExplorerProvider,
  ApiRequestArguments,
  NetworkId,
  networkIds,
  EnableOptionsBase
} from '@alephium/web3'

import { LOGGER, PROVIDER_NAMESPACE, RELAY_METHODS, RELAY_URL } from './constants'
import {
  AddressGroup,
  RelayMethodParams,
  RelayMethodResult,
  ProviderEvent,
  ProviderEventArgument,
  RelayMethod,
  ProjectMetaData,
  ChainInfo
} from './types'

export interface ProviderOptions extends EnableOptionsBase {
  // Alephium options
  networkId: NetworkId // the id of the network, e.g. mainnet, testnet or devnet.
  addressGroup?: number // either a specific group or undefined to support all groups
  methods?: RelayMethod[] // all of the methods to be used in relay; no need to configure in most cases

  // WalletConnect options
  projectId?: string
  metadata?: ProjectMetaData // metadata used to initialize a sign client
  logger?: string // default logger level is Error; no need to configure in most cases
  client?: SignClient // existing sign client; no need to configure in most cases
  relayUrl?: string // the url of the relay server; no need to configure in most cases
}

export class WalletConnectProvider extends SignerProvider {
  private providerOpts: ProviderOptions

  public events: EventEmitter = new EventEmitter()
  public nodeProvider: NodeProvider | undefined
  public explorerProvider: ExplorerProvider | undefined

  public networkId: NetworkId
  public addressGroup: AddressGroup
  public permittedChain: string
  public methods: RelayMethod[]

  public account: Account | undefined = undefined

  public client!: SignClient
  public session!: SessionTypes.Struct

  static async init(opts: ProviderOptions): Promise<WalletConnectProvider> {
    const provider = new WalletConnectProvider(opts)
    await provider.initialize()
    return provider
  }

  private constructor(opts: ProviderOptions) {
    super()

    this.providerOpts = opts
    this.networkId = opts.networkId
    this.addressGroup = opts.addressGroup
    this.permittedChain = formatChain(this.networkId, this.addressGroup)

    this.methods = opts.methods ?? [...RELAY_METHODS]
    if (this.methods.includes('alph_requestNodeApi')) {
      this.nodeProvider = NodeProvider.Remote(this.requestNodeAPI)
    } else {
      this.nodeProvider = undefined
    }
    if (this.methods.includes('alph_requestExplorerApi')) {
      this.explorerProvider = ExplorerProvider.Remote(this.requestExplorerAPI)
    } else {
      this.explorerProvider = undefined
    }
  }

  public async connect(): Promise<void> {
    const { uri, approval } = await this.client.connect({
      requiredNamespaces: {
        alephium: {
          chains: [this.permittedChain],
          methods: this.methods,
          events: ['accountChanged']
        }
      }
    })

    if (uri) {
      this.emitEvents('displayUri', uri)
    }

    this.session = await approval()
    this.updateNamespace(this.session.namespaces)
  }

  public async disconnect(): Promise<void> {
    if (!this.client) {
      throw new Error('Sign Client not initialized')
    }

    await this.providerOpts.onDisconnected()

    await this.client.disconnect({
      topic: this.session.topic,
      reason: getSdkError('USER_DISCONNECTED')
    })
  }

  public on<E extends ProviderEvent>(event: E, listener: (args: ProviderEventArgument<E>) => any): void {
    this.events.on(event, listener)
  }

  public once<E extends ProviderEvent>(event: ProviderEvent, listener: (args: ProviderEventArgument<E>) => any): void {
    this.events.once(event, listener)
  }

  public removeListener<E extends ProviderEvent>(
    event: ProviderEvent,
    listener: (args: ProviderEventArgument<E>) => any
  ): void {
    this.events.removeListener(event, listener)
  }

  public off<E extends ProviderEvent>(event: ProviderEvent, listener: (args: ProviderEventArgument<E>) => any): void {
    this.events.off(event, listener)
  }

  // ---------- Signer Methods ----------------------------------------------- //

  protected unsafeGetSelectedAccount(): Promise<Account> {
    if (this.account === undefined) {
      throw Error('Account is not available')
    }
    return Promise.resolve(this.account)
  }

  public async signAndSubmitTransferTx(params: SignTransferTxParams): Promise<SignTransferTxResult> {
    return this.typedRequest('alph_signAndSubmitTransferTx', params)
  }

  public async signAndSubmitDeployContractTx(params: SignDeployContractTxParams): Promise<SignDeployContractTxResult> {
    return this.typedRequest('alph_signAndSubmitDeployContractTx', params)
  }

  public async signAndSubmitExecuteScriptTx(params: SignExecuteScriptTxParams): Promise<SignExecuteScriptTxResult> {
    return this.typedRequest('alph_signAndSubmitExecuteScriptTx', params)
  }

  public async signAndSubmitUnsignedTx(params: SignUnsignedTxParams): Promise<SignUnsignedTxResult> {
    return this.typedRequest('alph_signAndSubmitUnsignedTx', params)
  }

  public async signUnsignedTx(params: SignUnsignedTxParams): Promise<SignUnsignedTxResult> {
    return this.typedRequest('alph_signUnsignedTx', params)
  }

  public async signMessage(params: SignMessageParams): Promise<SignMessageResult> {
    return this.typedRequest('alph_signMessage', params)
  }

  // ---------- Private ----------------------------------------------- //

  private async initialize() {
    await this.createClient()
    this.checkStorage()
    this.registerEventListeners()
  }

  private async createClient() {
    this.client =
      this.providerOpts.client ||
      (await SignClient.init({
        logger: this.providerOpts.logger || LOGGER,
        relayUrl: this.providerOpts.relayUrl || RELAY_URL,
        projectId: this.providerOpts.projectId,
        metadata: this.providerOpts.metadata // fetch metadata automatically if not provided?
      }))
  }

  private checkStorage() {
    if (this.client.session.length) {
      const lastKeyIndex = this.client.session.keys.length - 1
      this.session = this.client.session.get(this.client.session.keys[lastKeyIndex])
    }
  }

  private registerEventListeners() {
    if (typeof this.client === 'undefined') {
      throw new Error('Sign Client is not initialized')
    }

    this.client.on('session_ping', (args) => {
      this.emitEvents('session_ping', args)
    })

    this.client.on('session_event', (args) => {
      this.emitEvents('session_event', args)
    })

    this.client.on('session_update', ({ topic, params }) => {
      const { namespaces } = params
      const _session = this.client?.session.get(topic)
      this.session = { ..._session, namespaces } as SessionTypes.Struct
      this.updateNamespace(this.session.namespaces)
      this.emitEvents('session_update', { topic, params })
    })

    this.client.on('session_delete', () => {
      this.emitEvents('session_delete')
    })
  }

  private emitEvents(event: ProviderEvent, data?: any): void {
    this.events.emit(event, data)
  }

  private typedRequest<T extends RelayMethod>(method: T, params: RelayMethodParams<T>): Promise<RelayMethodResult<T>> {
    return this.request({ method, params })
  }

  // The provider only supports signer methods. The other requests should use Alephium Rest API.
  private async request<T = unknown>(args: { method: string; params: any }): Promise<T> {
    if (!(this.methods as string[]).includes(args.method)) {
      return Promise.reject(new Error(`Invalid method was passed: ${args.method}`))
    }

    if (!args.method.startsWith('alph_request')) {
      const signerAddress = args.params?.signerAddress
      if (typeof signerAddress === 'undefined') {
        throw new Error('Cannot request without signerAddress')
      }
      const selectedAddress = (await this.getSelectedAccount()).address
      if (signerAddress !== selectedAddress) {
        throw new Error(`Invalid signer address: ${args.params.signerAddress}`)
      }
    }

    try {
      const response = await this.client.request<T>({
        request: {
          method: args.method,
          params: args.params
        },
        chainId: this.permittedChain,
        topic: this.session?.topic
      })
      return response
    } catch (error: any) {
      if (error.message) {
        throw new Error(error.message)
      }
      throw error
    }
  }

  private requestNodeAPI = (args: ApiRequestArguments): Promise<any> => {
    return this.typedRequest('alph_requestNodeApi', args)
  }

  private requestExplorerAPI = (args: ApiRequestArguments): Promise<any> => {
    return this.typedRequest('alph_requestExplorerApi', args)
  }

  private updateNamespace(namespaces: SessionTypes.Namespaces) {
    const chains = getChainsFromNamespaces(namespaces, [PROVIDER_NAMESPACE])
    this.setChain(chains)
    const accounts = getAccountsFromNamespaces(namespaces, [PROVIDER_NAMESPACE])
    this.setAccounts(accounts)
  }

  private sameChains(chains0: string[], chains1?: string[]): boolean {
    if (typeof chains1 === 'undefined') {
      return false
    } else {
      return chains0.join() === chains1.join()
    }
  }

  private setChain(chains: string[]) {
    if (!this.sameChains(chains, [this.permittedChain])) {
      throw Error('Network or chain group has changed')
    }
  }

  private sameAccounts(account0: Account[], account1?: Account[]): boolean {
    if (typeof account1 === 'undefined') {
      return false
    } else {
      return account0.map((a) => a.address).join() === account1.map((a) => a.address).join()
    }
  }

  private lastSetAccounts?: Account[]
  private setAccounts(accounts: string[]) {
    const parsedAccounts = accounts.map(parseAccount)
    if (this.sameAccounts(parsedAccounts, this.lastSetAccounts)) {
      return
    } else {
      this.lastSetAccounts = parsedAccounts
    }

    if (parsedAccounts.length !== 1) {
      throw Error('The WC provider does not supports multiple accounts')
    }

    const newAccount = parsedAccounts[0]
    if (!isCompatibleAddressGroup(newAccount.group, this.addressGroup)) {
      throw Error('The new account belongs to an unexpected chain group')
    }

    this.account = newAccount
    this.emitEvents('accountChanged', newAccount)
  }
}

export function isCompatibleChain(chain: string): boolean {
  return chain.startsWith(`${PROVIDER_NAMESPACE}:`)
}

export function isCompatibleAddressGroup(group: number, expectedAddressGroup: AddressGroup): boolean {
  return expectedAddressGroup === undefined || expectedAddressGroup === group
}

export function formatChain(networkId: NetworkId, addressGroup: AddressGroup): string {
  if (addressGroup !== undefined && addressGroup < 0) {
    throw Error('Chain group in provider needs to be either undefined or non-negative')
  }
  const addressGroupEncoded = addressGroup !== undefined ? addressGroup : -1
  return `${PROVIDER_NAMESPACE}:${networkId}/${addressGroupEncoded}`
}

export function parseChain(chainString: string): ChainInfo {
  const [_namespace, networkId, addressGroup] = chainString.replace(/\//g, ':').split(':')
  const addressGroupDecoded = parseInt(addressGroup, 10)
  if (addressGroupDecoded < -1) {
    throw Error('Chain group in protocol needs to be either -1 or non-negative')
  }
  const networkIdList = networkIds as ReadonlyArray<string>
  if (!networkIdList.includes(networkId)) {
    throw Error(`Invalid network id, expect one of ${networkIdList}`)
  }
  return {
    networkId: networkId as NetworkId,
    addressGroup: addressGroupDecoded === -1 ? undefined : addressGroupDecoded
  }
}

export function formatAccount(permittedChain: string, account: Account): string {
  return `${permittedChain}:${account.publicKey}/${account.keyType}`
}

export function parseAccount(account: string): Account {
  const [_namespace, _networkId, _group, publicKey, keyType] = account.replace(/\//g, ':').split(':')
  const address = addressFromPublicKey(publicKey)
  const group = groupOfAddress(address)
  if (keyType !== 'default' && keyType !== 'bip340-schnorr') {
    throw Error(`Invalid key type: ${keyType}`)
  }
  return { address, group, publicKey, keyType }
}
