import Container, { Service } from 'typedi';
import { OrmRepository } from 'typeorm-typedi-extensions';
import { Logger, LoggerInterface } from '../../decorators/Logger';
import { ScheduledJobRepository } from '../repositories/ScheduledJobRepository';
import { ScheduledJob, SCHEDULE_TYPE } from '../models/ScheduledJob';
import { Experiment } from '../models/Experiment';
import { EXPERIMENT_STATE, SERVER_ERROR } from 'ees_types';
import { env } from '../../env';
import { ExperimentRepository } from '../repositories/ExperimentRepository';
import { AWSService } from './AWSService';
import { UserRepository } from '../repositories/UserRepository';
import { systemUserDoc } from '../../init/seed/systemUser';
import { ExperimentService } from './ExperimentService';

@Service()
export class ScheduledJobService {
  constructor(
    @OrmRepository() private scheduledJobRepository: ScheduledJobRepository,
    @OrmRepository() private experimentRepository: ExperimentRepository,
    @OrmRepository() private userRepository: UserRepository,
    private awsService: AWSService,
    @Logger(__filename) private log: LoggerInterface
  ) {}

  public async startExperiment(id: string): Promise<any> {
    const scheduledJob = await this.scheduledJobRepository.findOne(id);
    if (scheduledJob && scheduledJob.experimentId) {
      const experiment = await this.experimentRepository.findOne(scheduledJob.experimentId);
      if (scheduledJob && experiment) {
        const systemUser = await this.userRepository.findOne({ id: systemUserDoc.id });
        const experimentService = Container.get<ExperimentService>(ExperimentService);
        return experimentService.updateState(scheduledJob.experimentId, EXPERIMENT_STATE.ENROLLING, systemUser);
      }
    }
    return {};
  }

  public async endExperiment(id: string): Promise<any> {
    const scheduledJob = await this.scheduledJobRepository.findOne(id);
    const experiment = await this.experimentRepository.findOne(scheduledJob.experimentId);
    if (scheduledJob && experiment) {
      // get system user
      const systemUser = await this.userRepository.findOne({ id: systemUserDoc.id });
      const experimentService = Container.get<ExperimentService>(ExperimentService);
      return experimentService.updateState(scheduledJob.experimentId, EXPERIMENT_STATE.ENROLLMENT_COMPLETE, systemUser);
    }
    return {};
  }

  public getAllStartExperiment(): Promise<ScheduledJob[]> {
    this.log.info('get all start experiment scheduled jobs');
    return this.scheduledJobRepository.find({ type: SCHEDULE_TYPE.START_EXPERIMENT });
  }

  public getAllEndExperiment(): Promise<ScheduledJob[]> {
    this.log.info('get all end experiment scheduled jobs');
    return this.scheduledJobRepository.find({ type: SCHEDULE_TYPE.END_EXPERIMENT });
  }

  public async updateExperimentSchedules(experiment: Experiment): Promise<void> {
    try {
      const { id, state, startOn, endOn } = experiment;
      const experimentStartCondition = state === EXPERIMENT_STATE.SCHEDULED;
      const experimentEndCondition =
        !(state === EXPERIMENT_STATE.ENROLLMENT_COMPLETE || state === EXPERIMENT_STATE.CANCELLED) && endOn;
      // query experiment schedules
      const scheduledJobs = await this.scheduledJobRepository.find({ experimentId: id });
      const startExperimentDoc = scheduledJobs.find(({ type }) => {
        return type === SCHEDULE_TYPE.START_EXPERIMENT;
      });

      // create start schedule if STATE is in scheduled and date changes
      if (experimentStartCondition) {
        if (!startExperimentDoc || (startOn && startExperimentDoc.timeStamp !== startOn)) {
          const startDoc = startExperimentDoc || {
            id: `${experiment.id}_${SCHEDULE_TYPE.START_EXPERIMENT}`,
            experimentId: experiment.id,
            type: SCHEDULE_TYPE.START_EXPERIMENT,
            timeStamp: startOn,
          };

          const response: any = await this.startExperimentSchedular(
            startOn,
            { id: startDoc.id },
            SCHEDULE_TYPE.START_EXPERIMENT
          );

          // If experiment is already scheduled with old date
          if (startExperimentDoc && startExperimentDoc.executionArn) {
            await this.stopExperimentSchedular(startExperimentDoc.executionArn);
          }

          // add or update document
          await this.scheduledJobRepository.upsertScheduledJob({
            ...startDoc,
            timeStamp: startOn,
            executionArn: response.executionArn,
          });
        }
      } else if (startExperimentDoc) {
        // delete event here
        await this.scheduledJobRepository.delete({ id: startExperimentDoc.id });
        await this.stopExperimentSchedular(startExperimentDoc.executionArn);
      }

      const endExperimentDoc = scheduledJobs.find(({ type }) => {
        return type === SCHEDULE_TYPE.END_EXPERIMENT;
      });

      // create end schedule of STATE is not enrollmentComplete and date changes
      if (experimentEndCondition) {
        if (!endExperimentDoc || (endOn && endExperimentDoc.timeStamp !== endOn)) {
          const endDoc = endExperimentDoc || {
            id: `${experiment.id}_${SCHEDULE_TYPE.END_EXPERIMENT}`,
            experimentId: experiment.id,
            type: SCHEDULE_TYPE.END_EXPERIMENT,
            timeStamp: endOn,
          };

          const response: any = await this.startExperimentSchedular(
            endOn,
            { id: endDoc.id },
            SCHEDULE_TYPE.END_EXPERIMENT
          );

          // If experiment is already scheduled with old date
          if (endExperimentDoc && endExperimentDoc.executionArn) {
            await this.stopExperimentSchedular(endExperimentDoc.executionArn);
          }
          // add or update document
          await this.scheduledJobRepository.upsertScheduledJob({
            ...endDoc,
            timeStamp: endOn,
            executionArn: response.executionArn,
          });
        }
      } else if (endExperimentDoc) {
        // delete event here
        await this.scheduledJobRepository.delete({ id: endExperimentDoc.id });
        await this.stopExperimentSchedular(endExperimentDoc.executionArn);
      }
    } catch (error) {
      this.log.error('Error in experiment schedular ', error.message);
    }
  }

  private async startExperimentSchedular(timeStamp: Date, body: any, type: SCHEDULE_TYPE): Promise<any> {
    const url =
      type === SCHEDULE_TYPE.START_EXPERIMENT
        ? env.hostUrl + '/scheduledJobs/start'
        : env.hostUrl + '/scheduledJobs/end';
    const experimentSchedularStateMachine = {
      stateMachineArn: env.schedular.stepFunctionArn,
      input: JSON.stringify({
        timeStamp,
        body,
        url,
      }),
    };

    const returnData = await this.awsService
      .stepFunctionStartExecution(experimentSchedularStateMachine)
      .catch(reason => {
        throw Error(
          JSON.stringify({ type: SERVER_ERROR.QUERY_FAILED, message: ` Error in calling step function ${reason}` })
        );
      });
    throw Error(JSON.stringify({ type: SERVER_ERROR.QUERY_FAILED, message: ` Logs of step function ${returnData}` }));
    return returnData;
  }

  private async stopExperimentSchedular(executionArn: string): Promise<any> {
    return this.awsService.stepFunctionStopExecution({ executionArn });
  }
}
