const path = require('node:path');

function desktopPaths({ isPackaged, projectRoot, execPath, portableDirectory }) {
  // Portable launchers extract the application to TEMP. User data must stay
  // beside the original EXE, never inside that temporary copy or app.asar.
  const dataDirectory = isPackaged
    ? path.resolve(portableDirectory || path.dirname(execPath), '译桥数据')
    : path.resolve(projectRoot, '.local');
  return {
    dataDirectory,
    profile: path.join(dataDirectory, 'desktop-profile'),
    envFile: isPackaged ? path.join(dataDirectory, '.env') : path.join(projectRoot, '.env'),
  };
}

module.exports = { desktopPaths };
