import { MicroframeworkLoader, MicroframeworkSettings } from 'microframework';
import { createConnection, getConnectionOptions, ConnectionOptions } from 'typeorm';

import { env } from '../env';
import { SERVER_ERROR } from 'ees_types';

export const typeormLoader: MicroframeworkLoader = async (settings: MicroframeworkSettings | undefined) => {
  const loadedConnectionOptions = await getConnectionOptions();

  const connectionOptions: ConnectionOptions = Object.assign(loadedConnectionOptions, {
    type: env.db.type, // See createConnection options for valid types
    host: env.db.host,
    port: env.db.port,
    username: env.db.username,
    password: env.db.password,
    synchronize: env.db.synchronize,
    logging: env.db.logging,
    entities: env.app.dirs.entities,
    migrations: env.app.dirs.migrations,
  });

  try {
    const connection = await createConnection(connectionOptions);

    if (settings) {
      settings.setData('connection', connection);
      settings.onShutdown(() => connection.close());
    }
  } catch (error) {
    console.log('error', error);
    if (error.code === 'ECONNREFUSED') {
      throw new Error(SERVER_ERROR.DB_UNREACHABLE);
    } else {
      throw new Error(SERVER_ERROR.DB_AUTH_FAIL);
    }
  }
};
