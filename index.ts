import 'dotenv/config'
import { ethers } from 'ethers'
import { request, gql } from 'graphql-request'
import stakeManagerAbi from './abis/StakeManager.abi.json'
import maticAbi from './abis/Matic.abi.json'
import validatorShareAbi from './abis/ValidatorShare.abi.json'

const main = async (): Promise<void> => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL ?? 'https://rpc.ankr.com/eth')

  const stakeManager = new ethers.Contract('0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908', ethers.Interface.from(stakeManagerAbi), provider)
  const matic = new ethers.Contract('0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', ethers.Interface.from(maticAbi), provider)

  console.log('Current timestamp:', Date.now())

  const maticBalance = BigInt(await matic.balanceOf(stakeManager.getAddress()))
  const totalStake = BigInt(await stakeManager.currentValidatorSetTotalStake())
  console.log('Current MATIC balance:', maticBalance)
  console.log('Current MATIC staked:', totalStake)
  console.log('MATIC remaining for reward distribution:', maticBalance - totalStake)

  const lastCheckpointNumber: any = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
        checkpoints(first: 1, orderBy: checkpointNumber, orderDirection: desc) {
              checkpointNumber
        }
      }`) as any).checkpoints[0].checkpointNumber

  console.log('Last checkpoint number:', lastCheckpointNumber)

  let checkpointRewards = BigInt(0)
  for (let i = 1; i <= lastCheckpointNumber; i += 1000) {
    const checkpoints = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
            checkpoints(first: 1000, where: {checkpointNumber_gte: ${i}}, orderBy: checkpointNumber, orderDirection: asc) {
                  reward
            }
          }`) as any).checkpoints
    for (const checkpoint of checkpoints) {
      checkpointRewards += BigInt(checkpoint.reward)
    }
  }
  console.log('Total checkpoint rewards:', checkpointRewards)

  const lastDelegatorCounter: any = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
        delegators(first: 1, orderBy: counter, orderDirection: desc) {
          counter
        }
      }`) as any).delegators[0].counter

  console.log('Last delegator number:', lastDelegatorCounter)

  let delegatorClaimedRewards = BigInt(0)
  let delegatorStakeAmount = BigInt(0)
  let delegatorUnclaimedRewards = BigInt(0)
  const validatorContracts: any = {}
  const liquidRewardPromises: any[] = []
  for (let i = 1; i <= lastDelegatorCounter; i += 1000) {
    const delegators = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
            delegators(first: 1000, where: {counter_gte: ${i}}, orderBy: counter, orderDirection: asc) {
              claimedRewards
              delegatedAmount
              validatorId
              address
            }
          }`) as any).delegators

    for (const delegator of delegators) {
      delegatorClaimedRewards += BigInt(delegator.claimedRewards)
      delegatorStakeAmount += BigInt(delegator.delegatedAmount)
      if (validatorContracts[delegator.validatorId] === undefined) {
        validatorContracts[delegator.validatorId] = new ethers.Contract(await stakeManager.getValidatorContract(delegator.validatorId), ethers.Interface.from(validatorShareAbi), provider)
      }
      liquidRewardPromises.push(validatorContracts[delegator.validatorId].getLiquidRewards(delegator.address))
    }
  }
  const liquidRewards = await Promise.all(liquidRewardPromises)
  for (const liquidReward of liquidRewards) {
    delegatorUnclaimedRewards += BigInt(liquidReward)
  }
  console.log('Total delegator claimed rewards:', delegatorClaimedRewards)
  console.log('Total delegator unclaimed rewards:', delegatorUnclaimedRewards)
  console.log('Total delegator stake:', delegatorStakeAmount)

  const lastValidatorId = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
        validators(first: 1, orderBy: validatorId, orderDirection: desc) {
          validatorId
        }
      }`) as any).validators[0].validatorId
  console.log('Last validator ID:', lastValidatorId)

  let validatorClaimedRewards = BigInt(0)
  let validatorUnclaimedRewards = BigInt(0)
  let validatorSelfStake = BigInt(0)
  let validatorUnclaimedStake = BigInt(0)
  let delegatorUnclaimedStake = BigInt(0)
  let validatorUnclaimedTotalStaked = BigInt(0)
  for (let i = 1; i <= lastValidatorId; i += 1000) {
    const validators = (await request('https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs', gql`{
            validators(first: 1000, where: {validatorId_gte: ${i}}, orderBy: validatorId, orderDirection: asc) {
              validatorId
              liquidatedRewards
              status
              selfStake
              totalStaked
              delegatedStake
            }
          }`) as any).validators
    for (const validator of validators) {
      validatorClaimedRewards += BigInt(validator.liquidatedRewards)
      validatorUnclaimedRewards += BigInt(await stakeManager.validatorReward(validator.validatorId))
      if (validator.status === 0) {
        validatorSelfStake += BigInt(validator.selfStake)
      } else {
        validatorUnclaimedStake += BigInt(validator.selfStake)
        delegatorUnclaimedStake += BigInt(validator.delegatedStake)
        validatorUnclaimedTotalStaked += BigInt(validator.totalStaked)
      }
    }
  }
  console.log('Total validator claimed rewards:', validatorClaimedRewards)
  console.log('Total validator unclaimed rewards:', validatorUnclaimedRewards)
  console.log('Total validator self-stake:', validatorSelfStake)
  console.log('Total inactive delegator stake:', delegatorUnclaimedStake)
  console.log('Total inactive validator stake:', validatorUnclaimedStake)
  console.log('Total inactive total staked:', validatorUnclaimedTotalStaked)
  console.log('Compare inactive stake amounts', validatorUnclaimedStake + delegatorUnclaimedStake, validatorUnclaimedTotalStaked)
  console.log('Total unclaimed rewards:', checkpointRewards - delegatorClaimedRewards - validatorClaimedRewards)
  console.log('Compare stake amount:', totalStake, delegatorStakeAmount + validatorSelfStake - validatorUnclaimedTotalStaked)
  console.log('Surplus', maticBalance - totalStake - validatorUnclaimedStake - delegatorUnclaimedStake - delegatorUnclaimedRewards - validatorUnclaimedRewards)
}

void main()
